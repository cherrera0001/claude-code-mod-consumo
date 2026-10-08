// Pruebas del guion del index vivo. Cada una arma sus repositorios en una carpeta temporal, con un remoto local
// desnudo y árboles de agentes; ninguna toca la red (la función de petición se inyecta) ni un repositorio real.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as indice from './indice.mjs'
import { MINUTO, carpetaTemporal, confirmar, entorno, escenario, escribir, git, limpiar, moverRemoto } from './pruebas-comun.mjs'

after(limpiar)

const aqui = path.dirname(fileURLToPath(import.meta.url))
const GUION = path.join(aqui, 'indice.mjs')
const sinRespuesta = async () => ({ status: 0, texto: '' })

async function correr(e, opciones = {}) {
  const r = await indice.generar({ raices: [e.raiz], salida: e.salida, pedir: sinRespuesta, ...opciones })
  const json = fs.readFileSync(`${e.salida}/index.json`, 'utf8')
  return { r, json, datos: JSON.parse(json), html: fs.readFileSync(`${e.salida}/index.html`, 'utf8') }
}
const deTipo = (datos, tipo) => datos.cuellos.filter(c => c.tipo === tipo)
const en40 = () => Date.now() + 40 * MINUTO

// ── Lo básico ───────────────────────────────────────────────────────────────────────────────────────

test('un repositorio limpio y al día no tiene cuellos, y cada árbol sale con su trabajador', async () => {
  const e = escenario()
  const { datos, html } = await correr(e)
  assert.deepEqual(datos.cuellos, [])
  assert.equal(Object.keys(datos)[0], 'cuellos', 'los cuellos van arriba del todo')
  assert.equal(typeof datos.duracion_ms, 'number')
  assert.match(datos.foto, /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/)
  const [repo] = datos.repositorios
  assert.equal(repo.arboles.length, 3)
  assert.deepEqual(repo.arboles.map(a => [a.trabajador, a.rama, a.issue, a.sin_confirmar, a.delante, a.detras, a.stash]), [
    ['sesión principal', 'main', null, 0, 0, 0, 0],
    ['agy', 'agy/12', 12, 0, 0, 0, 0],
    ['codex', 'codex/34', 34, 0, 0, 0, 0],
  ])
  assert.equal(repo.arboles[0].ultimo_commit.asunto, 'primer commit')
  assert.equal(repo.origen.remoto_movido, false)
  assert.match(html, /<meta http-equiv="refresh" content="30">/)
  assert.match(html, /Nada espera fuera de lo habitual/)
  assert.match(html, /Se comparó contra: piezas con más de 30 min sin integrar/)
})

test('la página es autocontenida: sin fetch, sin recursos externos, y los cuellos van antes que las tablas', async () => {
  const e = escenario()
  confirmar(e.agy, 'pieza.txt', 'x\n')
  const { html } = await correr(e, { ahora: en40() })
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|<link|src=|href=|@import|url\((?!#)/)
  const orden = ['<h1>Index de trabajo', '<h2>Avisos', '<h2>Dónde espera el trabajo ahora</h2>', '<h2>Coordinación', '<h2>Flujo', '<h2>Quién está en qué</h2>', 'Medido · migraciones', 'Declarado · el control', '<h2>Producción</h2>', '<h2>Costo</h2>', '<h2>Lo que esta página no sabe</h2>', '<footer>'].map(t => html.indexOf(t))
  assert.ok(orden.every((p, i) => p >= 0 && (i === 0 || p > orden[i - 1])), `el orden de la página no es el pedido: ${orden}`)
  assert.match(html, /id="vieja" hidden/)
  assert.match(html, /El index no se está actualizando/)
  // El único guion de la página enseña el aviso de foto vieja: una sola etiqueta, y no escribe ni pide nada.
  assert.equal(html.match(/<script/g).length, 1)
})

// ── Cada cuello: una prueba que lo provoca y otra que no ────────────────────────────────────────────

test('migración repetida entre dos ramas: cuello alto; un número tomado por una sola rama, no', async () => {
  const e = escenario()
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'migracion'), [])
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0003')
  assert.deepEqual(datos.repositorios[0].migraciones.tomados, [{ numero: '0002', rama: 'agy/12', fichero: '0002_de_agy.sql', confirmado: true }])

  confirmar(e.codex, 'db/migrations/0002_de_codex.sql', '-- c\n')
  ;({ datos } = await correr(e))
  const [c] = deTipo(datos, 'migracion')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /0002/)
  assert.match(c.que, /agy\/12/)
  assert.match(c.que, /codex\/34/)
  assert.equal(datos.cuellos[0].tipo, 'migracion', 'los altos van primero')
})

test('migración repetida entre una rama y main: cuello alto; la misma migración heredada de main, no', async () => {
  const e = escenario()
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  confirmar(e.raiz, 'db/migrations/0002_de_main.sql', '-- m\n')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  // codex parte del main nuevo: trae la 0002 de main, que no es suya.
  git(e.codex, 'merge', '-q', '--ff-only', 'main')
  confirmar(e.codex, 'otra-cosa.txt', 'x\n')
  const { datos } = await correr(e)
  const cuellos = deTipo(datos, 'migracion')
  assert.equal(cuellos.length, 1)
  assert.match(cuellos[0].que, /main \(0002_de_main\.sql\) y agy\/12 \(0002_de_agy\.sql\)/)
  assert.doesNotMatch(cuellos[0].que, /codex/)
  assert.equal(datos.repositorios[0].migraciones.ultimo_en_principal, '0002')
})

// ── La tabla de reservas de migraciones ─────────────────────────────────────────────────────────────

const conReservas = migraciones => ({ cola: [12, 34], migraciones })

test('(a) un número en uso sin reserva, o con la reserva de otra issue: cuello alto; con su reserva, no', async () => {
  let e = escenario({ estado: conReservas({ _regla: 'Regla-Calabaza en texto libre', '0002': { issue: 12, quien: 'agente backend', estado: 'escrita, sin integrar', fichero: '0002_de_agy.sql' }, siguiente_libre: '0003' }) })
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  let { datos, json, html } = await correr(e)
  assert.deepEqual(deTipo(datos, 'reserva'), [], 'agy/12 usa la 0002, reservada para la #12')
  assert.deepEqual(deTipo(datos, 'siguiente-libre'), [])
  assert.deepEqual(datos.repositorios[0].migraciones.reservas.tabla, [{ numero: '0002', issue: 12, reservada: true, reservada_para: 'agente backend', usada_en: ['agy/12'], estado: 'en uso, con su reserva' }])
  assert.equal((json + html).includes('Calabaza'), false, 'la regla en texto libre no sale')

  // La reserva es de la #34 y quien la usa es la rama de la #12.
  e = escenario({ estado: conReservas({ '0002': { issue: 34, quien: 'agente backend', estado: 'reservada' } }) })
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  ;({ datos } = await correr(e))
  assert.deepEqual(deTipo(datos, 'reserva'), [], 'un solo aviso por número: el de migración')
  let [c] = deTipo(datos, 'migracion')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /La migración 0002 está en uso en agy\/12 y su reserva es de la #34/)

  // No hay reserva para el número que la rama usa.
  e = escenario({ estado: conReservas({ '0002': { issue: 12, quien: 'agente backend', estado: 'reservada' } }) })
  confirmar(e.codex, 'db/migrations/0003_de_codex.sql', '-- c\n')
  ;({ datos } = await correr(e))
  ;[c] = deTipo(datos, 'migracion')
  assert.match(c.que, /La migración 0003 está en uso en codex\/34 y no está reservada para ella/)
  assert.equal(deTipo(datos, 'migracion').length, 1)

  // Un número repetido Y sin reserva: un solo aviso, con todo en una frase.
  e = escenario({ estado: conReservas({ '0009': { issue: 12, quien: 'agente backend', estado: 'reservada' } }) })
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  confirmar(e.codex, 'db/migrations/0002_de_codex.sql', '-- c\n')
  ;({ datos } = await correr(e))
  assert.equal(datos.cuellos.filter(x => /0002/.test(x.que)).length, 1, 'un aviso por hecho')
  ;[c] = deTipo(datos, 'migracion')
  assert.match(c.que, /El número de migración 0002 está tomado 2 veces: agy\/12 \(0002_de_agy\.sql\) y codex\/34 \(0002_de_codex\.sql\)\. Además no está reservado para agy\/12 ni para codex\/34\./)
})

test('(b) el mismo número con ficheros distintos en dos sitios, y un fichero sin seguimiento cuenta como uso', async () => {
  const e = escenario()
  // Sin confirmar todavía: es donde un número aparece primero.
  escribir(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'migracion'), [], 'un solo uso no es una repetición')
  assert.deepEqual(datos.repositorios[0].migraciones.tomados, [{ numero: '0002', rama: 'agy/12', fichero: '0002_de_agy.sql', confirmado: false }])
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0003', 'el fichero sin seguimiento ya ocupa el número')

  confirmar(e.codex, 'db/migrations/0002_de_codex.sql', '-- c\n')
  ;({ datos } = await correr(e))
  const [c] = deTipo(datos, 'migracion')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /0002_de_agy\.sql/)
  assert.match(c.que, /0002_de_codex\.sql/)

  // Sin tabla declarada no hay comparaciones con la reserva: sólo la repetición.
  assert.doesNotMatch(c.que, /reserva/)
  // El mismo fichero en dos ramas (una sale de la otra y lo siguió editando) es la misma migración, no una repetición.
  const otro = escenario()
  confirmar(otro.agy, 'db/migrations/0002_misma.sql', '-- primera versión\n')
  git(otro.codex, 'merge', '-q', '--ff-only', 'agy/12')
  confirmar(otro.codex, 'db/migrations/0002_misma.sql', '-- segunda versión\n')
  assert.deepEqual(deTipo((await correr(otro)).datos, 'migracion'), [])
  assert.equal(datos.repositorios[0].migraciones.reservas.declaradas, false)
})

test('(b) una carpeta de migraciones entera sin seguimiento también se lee', async () => {
  const e = escenario({ estado: { herramientas: { migraciones: 'esquema/cambios' } } })
  escribir(e.agy, 'esquema/cambios/0005_nueva.sql', '-- a\n')
  const { datos } = await correr(e)
  assert.deepEqual(datos.repositorios[0].migraciones.tomados, [{ numero: '0005', rama: 'agy/12', fichero: '0005_nueva.sql', confirmado: false }])
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0006')
})

test('(c) siguiente_libre declarado menor o igual que un número usado o reservado: cuello alto, y gana el medido; si es libre, no', async () => {
  let e = escenario({ estado: conReservas({ '0002': { issue: 12, quien: 'agente backend', estado: 'reservada' }, '0004': { issue: 34, quien: 'agente backend', estado: 'reservada' }, siguiente_libre: '0005' }) })
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'siguiente-libre'), [])
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0005')
  assert.equal(datos.repositorios[0].migraciones.difiere_del_declarado, false)
  assert.match(fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8'), /SIGUIENTE NÚMERO LIBRE, MEDIDO: 0005 \(coincide con el declarado\)/)

  e = escenario({ estado: conReservas({ '0002': { issue: 12, quien: 'agente backend', estado: 'reservada' }, '0004': { issue: 34, quien: 'agente backend', estado: 'reservada' }, siguiente_libre: '0004' }) })
  // Y además alguien ya escribió la 0005 en su árbol, sin confirmar.
  escribir(e.codex, 'db/migrations/0005_de_codex.sql', '-- c\n')
  let html
  ;({ datos, html } = await correr(e))
  const [c] = deTipo(datos, 'siguiente-libre')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /siguiente_libre declarado \(0004\) no es libre.*El medido es 0006/)
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0006')
  const md = fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8')
  assert.match(md, />>> SIGUIENTE NÚMERO LIBRE, MEDIDO: 0006 · OJO: el declarado en orquestacion\.json dice 0004 y NO COINCIDE; vale el medido <<</)
  assert.match(md, /0002 \(#12; sin fichero; reservada, sin fichero en ningún sitio\) · 0004 \(#34; sin fichero; reservada, sin fichero en ningún sitio\) · 0005 \(#34; usada en codex\/34 \(sin confirmar\); EN USO SIN RESERVA\)/)
  assert.match(html, /Siguiente número libre, medido: <code>0006<\/code><\/strong>\. El declarado dice <code>0004<\/code>: <strong>NO COINCIDE<\/strong>/)
  assert.doesNotMatch(md, /agente backend/, 'en la pizarra va el estado medido, no el texto declarado')
})

test('una reserva «reservada» sin fichero en ningún sitio tras 2 horas: cuello medio; antes, o con su fichero, no', async () => {
  const e = escenario({ estado: conReservas({ '0002': { issue: 12, quien: 'agente backend', estado: 'reservada' }, '0003': { issue: 34, quien: 'agente backend', estado: 'escrita, sin integrar' } }) })
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'reserva-vacia'), [], 'recién vista')
  // Tres horas después de la primera vez que el guion la vio vacía (lo recuerda en vistos.json).
  ;({ datos } = await correr(e, { ahora: Date.now() + 180 * MINUTO }))
  const [c] = deTipo(datos, 'reserva-vacia')
  assert.equal(c.gravedad, 'media')
  assert.match(c.que, /La migración 0002 lleva 3 h 0 min reservada sin fichero/)
  assert.equal(deTipo(datos, 'reserva-vacia').length, 1, 'la 0003 no está en estado «reservada»')
  // Aparece el fichero, aunque sea sin confirmar: deja de ser una reserva vacía.
  escribir(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  ;({ datos } = await correr(e, { ahora: Date.now() + 181 * MINUTO }))
  assert.deepEqual(deTipo(datos, 'reserva-vacia'), [])
})

// ── El diseño de la página ──────────────────────────────────────────────────────────────────────────

/** El texto que se lee: sin estilos, sin el guion, sin etiquetas y sin atributos. */
const visible = html => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/<title>[^<]*<\/title>/g, '').replace(/<[^>]+>/g, ' ')
const cercaDeMedianoche = () => {
  const d = new Date()
  return d.getHours() === 23 && d.getMinutes() >= 10
}

test('la página lleva la piel de la plantilla canónica, sin nada remoto ni colores nuevos', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  confirmar(e.codex, 'pieza.txt', 'lista\n')
  const { html } = await correr(e, { sinRed: true, ahora: en40() })
  assert.ok(html.includes('<!-- datito:template:v1 -->'))
  assert.ok(html.indexOf('<!-- datito:template:v1 -->') < html.indexOf('</head>'))
  assert.equal(html.match(/:root\{/g).length, 1, 'un único bloque :root')
  for (const token of ['--tinta:#1a1a1a', '--suave:#666', '--linea:#d8d8d8', '--fondo:#faf9f7', '--azul:#2563eb', '--rojo:#dc2626', '--verde:#059669', '--ambar:#d97706', '--morado:#7c3aed']) assert.ok(html.includes(token), `falta el token ${token}`)
  for (const regla of ['.clave{', '.nota{', '.peligro{', '.panel{', '.met{', '.met .n{', '.met .e{', '.lbl{', '.fuente{', 'td.num{', 'details{', 'summary{', 'footer{', 'main{max-width:1100px', '.aviso{', '.aviso .cifra{', '.nm{', '.tabla-ancha{', 'th.num{']) assert.ok(html.includes(regla), `falta la regla ${regla}`)
  assert.doesNotMatch(html, /<link\b/i)
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/i)
  assert.doesNotMatch(html, /@import/i)
  assert.doesNotMatch(html, /https?:\/\//i, 'ninguna URL en toda la página')
  assert.doesNotMatch(html, /gradient/i)
  const permitidos = new Set(['#1a1a1a', '#666', '#d8d8d8', '#faf9f7', '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#374151', '#f1f0ee', '#eff6ff', '#fffbeb', '#fef2f2', '#fff'])
  for (const color of html.match(/#[0-9a-fA-F]{3,8}\b(?=[;}\s"])/g) ?? []) assert.ok(permitidos.has(color.toLowerCase()), `color fuera de la plantilla: ${color}`)
  assert.doesNotMatch(html, /(fill|stroke)="(?!var\(--|#fff"|url\(#trama\)"|none")/, 'los gráficos sólo usan los tokens')
  assert.equal(html.match(/<h1\b/g).length, 1)
  assert.equal(html.match(/<main\b/g).length, 1)
  assert.equal(html.match(/<script/g).length, 1)
  // Tablas con desplazamiento propio (a 390 px no desbordan la página) y columnas numéricas a la derecha.
  assert.equal(html.match(/<table/g).length, html.match(/<div class="tabla-ancha"><table/g).length)
  assert.match(html, /<th class="num">Sin confirmar<\/th>/)
  // Horas en la zona local con la UTC en title.
  assert.match(html, /<span title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">\d{4}-\d\d-\d\d \d\d:\d\d<\/span>/)
})

test('presentación: NO MEDIDO con su motivo y nunca 0, ni guion, ni hueco; y la lista final de lo que la página no sabe', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  const { html } = await correr(e, { sinRed: true })
  assert.match(html, /<span class="n"><span class="nm">NO MEDIDO<\/span> <span class="pie">esta foto se tomó sin red<\/span><\/span><span class="e">issues abiertas<\/span>/)
  assert.match(html, /<span class="n"><span class="nm">NO MEDIDO<\/span> <span class="pie">esta foto se tomó sin red<\/span><\/span><span class="e">issues cerradas hoy<\/span>/)
  assert.doesNotMatch(html, /<span class="n">0<\/span><span class="e">issues/)
  assert.match(html, /<div class="cifra"><span class="nm">NO MEDIDO<\/span> <span class="pie">esta foto se tomó sin red<\/span><\/div><div><strong>issues abiertas que no pueden avanzar solas/)
  assert.match(html, /<div class="cifra"><span class="nm">NO MEDIDO<\/span> <span class="pie">el repositorio no tiene registro de incidentes/)
  // Ni «—», ni «n/d», ni una celda vacía, ni un contenedor con identificador vacío.
  const texto = visible(html)
  // «—» sólo quiere decir «no hay» en una celda de la tabla; nunca ocupa el sitio de una cifra que falta.
  assert.doesNotMatch(texto, /\bn\/d\b/)
  assert.doesNotMatch(html, /<span class="n">—|<div class="cifra">—/)
  assert.doesNotMatch(html, /<td[^>]*>\s*<\/td>/)
  assert.doesNotMatch(html, /<(\w+)[^>]*\bid="[^"]+"[^>]*>\s*<\/\1>/)
  // Cada NO MEDIDO del cuerpo aparece otra vez, con su razón, en la lista del final.
  const final = html.slice(html.indexOf('<h2>Lo que esta página no sabe</h2>'), html.indexOf('<footer>'))
  const enLista = final.match(/<li>/g).length
  assert.ok(enLista >= 8, `la lista final tiene ${enLista} entradas`)
  for (const que of ['issues abiertas', 'issues abiertas que no pueden avanzar solas', 'altas y cierres por semana de plataforma', 'tiempo de entrega de plataforma', 'issues hechas sin commit de plataforma', 'commits sin integrar al cierre de cada día de plataforma', 'proyección de la cola de plataforma', 'costo por issue construida', 'cuándo quedó terminada cada pieza', 'salud de producción de plataforma', 'incidentes de coordinación de plataforma']) assert.ok(final.includes(`<strong>${que}</strong>: <span class="nm">NO MEDIDO</span>`), `falta en la lista: ${que}`)
  // Un cero sólo si se miró, y dice lo que se miró.
  assert.match(html, /<div class="cifra">0 commits<\/div><div><strong>escritos hoy que estén esperando[\s\S]{0,200}Se miraron 3 ramas locales/)
})

test('presentación: cada cifra con su unidad, su n y su ventana; ningún porcentaje; ninguna frase prohibida; estado con texto y forma', async () => {
  const e = escenario({ estado: { cola: [12] } })
  confirmar(e.codex, 'pieza.txt', 'lista\n')
  escribir(e.agy, 'a-medias.txt', 'x\n')
  const { html } = await correr(e, { ahora: en40(), sinRed: true })
  const texto = visible(html)
  assert.doesNotMatch(texto, /\d\s*%/, 'ningún porcentaje: se escribe «k de n»')
  // «una vez al día» (la frecuencia con que se recalcula el umbral) no es la conclusión prohibida «está al día».
  assert.doesNotMatch(texto, /(?<!una vez )\bal día\b|velocidad|productividad|rendimiento|en promedio|\bculpa\b|sin problemas|\blisto\b|quién falló/i)
  assert.doesNotMatch(texto, /\binactiv[oa]/i)
  // Los bloques de «dónde espera»: cifra con unidad a la izquierda; a la derecha la frase en negrita y debajo n, ventana y fuente.
  const avisos = html.match(/<div class="(?:nota|clave|peligro) aviso">[\s\S]*?<\/div><\/div><\/div>|<div class="(?:nota|clave|peligro) aviso"><div class="cifra"><span class="nm">[\s\S]*?<\/div><\/div>/g)
  assert.ok(avisos.length >= 4, `hay ${avisos?.length} bloques`)
  const medidos = avisos.filter(a => !a.includes('<div class="cifra"><span class="nm">'))
  assert.ok(medidos.length >= 2)
  for (const a of medidos) {
    assert.match(a, /<div class="cifra">\d+ (commits?|min|h \d+ min|de \d+|hoy)/, `cifra sin unidad: ${a.slice(0, 90)}`)
    assert.match(a, /<div><strong>/, 'la frase va en negrita')
    assert.match(a, /<div class="pie">[\s\S]*(n = \d+|Se miraron \d+)/, `sin n: ${a.slice(0, 90)}`)
    assert.match(a, /<div class="pie">[\s\S]*(foto de las \d\d:\d\d|[Vv]entana: hoy)/, `sin ventana: ${a.slice(0, 90)}`)
    assert.match(a, /<div class="pie">[\s\S]*fuente: /, `sin fuente: ${a.slice(0, 90)}`)
  }
  // Las fichas: número con unidad en la etiqueta, y debajo n y ventana.
  const fichas = [...html.matchAll(/<div><span class="n">([^<]+)<\/span><span class="e">([^<]+)<\/span><span class="fuente">([^<]+)<\/span><\/div>/g)]
  assert.equal(fichas.length, 3)
  for (const [, , etiqueta, pie] of fichas) {
    assert.match(pie, /n = \d+ árbol/, `${etiqueta}: sin n`)
    assert.match(pie, /foto de las \d\d:\d\d/, `${etiqueta}: sin ventana`)
    assert.match(pie, /git/, `${etiqueta}: sin fuente`)
  }
  assert.match(html, /<span class="n">1<\/span><span class="e">piezas terminadas sin integrar \(aprox\.\)<\/span>/)
  assert.match(html, /<span class="n">4\d min<\/span><span class="e">la espera más larga<\/span><span class="fuente">a-medias|<span class="n">4\d min<\/span><span class="e">la espera más larga<\/span><span class="fuente">(agy\/12|codex\/34)/)
  // Gravedad y estado con texto y forma, no sólo color; lo declarado separado de lo medido.
  assert.match(html, /<div class="nota"><strong>▲ MEDIA<\/strong> · /)
  assert.match(html, /■ <strong>terminada, sin integrar hace 4\d min \(aprox\.: desde su último commit\)<\/strong>/)
  assert.match(html, /■ <strong>tiene trabajo a medias<\/strong>/)
  assert.match(html, /○ <strong>sin cambios locales y sin commits por delante<\/strong>/)
  assert.match(html, /<p class="lbl">Medido · git y disco<\/p>/)
  assert.match(html, /<p class="lbl">Declarado · el control/)
  // La tabla va por lo que espera: primero el trabajo a medias y la pieza que espera; después lo que no tiene nada pendiente.
  const tabla = html.slice(html.indexOf('<p class="lbl">Medido · git y disco</p>'))
  assert.ok(tabla.indexOf('<code>agy/12</code>') < tabla.indexOf('<code>main</code>'))
  assert.ok(tabla.indexOf('<code>codex/34</code>') < tabla.indexOf('<code>main</code>'))
  // El gráfico: SVG en línea, una serie, con su unidad, su ventana y sus cifras debajo.
  assert.equal(html.match(/<svg /g).length, 1)
  assert.match(html, /<svg [^>]*role="img" aria-label="[^"]+"/)
  assert.match(html, /<p class="ley">Por qué este gráfico: [\s\S]*Unidad: commits\. Ventana: hoy, \d\d:\d\d a \d\d:\d\d \(n = \d+ cuartos de hora\)\. Cifras: /)
})

test('con una credencial rechazada el motivo del NO MEDIDO lo dice, y un cuello alto va en un bloque de peligro con la palabra ALTA', async () => {
  const e = escenario()
  const g = github(e, [['api.github.com/user', { status: 401, texto: '{}' }]])
  const { html } = await correr(e, { raices: undefined, pedir: g.pedir })
  assert.match(html, /<div class="peligro"><strong>■ ALTA<\/strong> · GitHub rechazó la credencial/)
  assert.match(html, /<span class="nm">NO MEDIDO<\/span> <span class="pie">GitHub rechazó la credencial<\/span><\/span><span class="e">issues abiertas<\/span>/)
})

test('como mucho tres avisos a la vista si no son de gravedad alta; el resto, en un desplegable con su recuento', async () => {
  const e = escenario()
  // Cinco hechos distintos: dos piezas que esperan, un stash en main y dos árboles con trabajo sin confirmar.
  confirmar(e.agy, 'pieza.txt', 'x\n')
  confirmar(e.codex, 'pieza.txt', 'x\n')
  fs.appendFileSync(path.join(e.raiz, 'LEEME.txt'), 'a medias\n')
  git(e.raiz, 'stash')
  for (const [rama, carpeta] of [['beta/56', 'plataforma-beta'], ['gama/78', 'plataforma-gama']]) {
    git(e.raiz, 'worktree', 'add', '-q', '-b', rama, `${e.dir}/${carpeta}`)
    escribir(`${e.dir}/${carpeta}`, 'a-medias.txt', 'x\n')
  }
  const { html, datos } = await correr(e, { ahora: en40(), sinRed: true })
  assert.deepEqual(datos.cuellos.map(c => c.tipo).sort(), ['pieza', 'pieza', 'sin-confirmar', 'sin-confirmar', 'stash'])
  const avisos = html.slice(html.indexOf('<h2>Avisos'), html.indexOf('<h2>Dónde espera'))
  assert.match(avisos, /<h2>Avisos · 5 cuellos de botella<\/h2>/)
  assert.equal(avisos.slice(0, avisos.indexOf('<details>')).match(/▲ MEDIA/g).length, 3)
  assert.match(avisos, /<summary>2 avisos más, de gravedad media<\/summary>/)
  // Dentro de cada gravedad, lo más reciente primero.
  const desde = datos.cuellos.map(c => c.desde_ms)
  assert.deepEqual(desde, [...desde].sort((a, b) => b - a))
})

test('un aviso por árbol: el stash de una rama que ya avisa por trabajo sin confirmar va en la misma frase', async () => {
  const e = escenario()
  fs.appendFileSync(path.join(e.agy, 'LEEME.txt'), 'guardado\n')
  git(e.agy, 'stash')
  escribir(e.agy, 'a-medias.txt', 'x\n')
  const { datos } = await correr(e, { ahora: en40(), sinRed: true })
  assert.equal(datos.cuellos.length, 1)
  assert.match(datos.cuellos[0].que, /agy \(agy\/12\) tiene trabajo sin confirmar: 1 fichero; el más reciente, tocado hace 40 min, y 1 entrada en el stash\./)
})

// ── Dónde espera el trabajo: huecos de empuje, commits sin integrar, bloqueadas, caducadas, incidentes ──

test('el umbral de huecos es el percentil 95 de los huecos entre empujes del mismo día, y con menos de 40 no se publica', () => {
  const dia = new Date(2026, 4, 20, 9, 0, 0).getTime()
  // 45 empujes en un día, cada 10 min, y uno más a la mañana siguiente: el hueco de la noche no cuenta.
  const empujes = Array.from({ length: 45 }, (_, i) => ({ ms: dia + i * 10 * MINUTO, empuje: true }))
  const entradas = [...empujes, { ms: dia + 24 * 60 * MINUTO, empuje: true }, { ms: dia + 5 * MINUTO, empuje: false }]
  const u = indice.umbralDeHuecos(entradas, dia + 30 * 60 * MINUTO)
  assert.deepEqual(u, { calculado: indice.diaLocal(dia + 30 * 60 * MINUTO), n: 44, dias: 2, desde: indice.diaLocal(dia), p95_min: 10 })
  const pocos = indice.umbralDeHuecos(empujes.slice(0, 30), dia)
  assert.equal(pocos.n, 29)
  assert.equal(pocos.p95_min, null, 'n = 29 es insuficiente para un P95')
  assert.equal(indice.cuantil([1, 2, 3, 4, 100], 0.5), 3)
})

test('hueco desde el último empuje mayor que el P95 guardado, con commits de hoy esperando: cuello alto; por debajo, o sin commits esperando, no', async t => {
  if (cercaDeMedianoche()) return t.skip('a menos de una hora de la medianoche local el «hoy» de la prueba cambia a mitad')
  const e = escenario()
  const guardar = p95 => fs.writeFileSync(`${e.salida}/umbrales.json`, JSON.stringify({ [e.raiz.toLowerCase()]: { calculado: indice.diaLocal(Date.now()), n: 60, dias: 9, desde: '2026-01-01', p95_min: p95 } }))
  const en20 = Date.now() + 20 * MINUTO
  guardar(5)
  let { datos, html } = await correr(e, { ahora: en20 })
  assert.deepEqual(deTipo(datos, 'hueco'), [], 'hay hueco, pero nada escrito esperando')
  assert.match(html, /<div class="cifra">0 commits<\/div>/)

  confirmar(e.agy, 'pieza.txt', 'x\n')
  ;({ datos, html } = await correr(e, { ahora: en20 }))
  const [c] = deTipo(datos, 'hueco')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /Hace (19|20|21) min que nada llega a origin\/main y hay 1 commits de hoy esperando.*percentil 95 de los huecos entre empujes es 5 min \(n = 60\)/)
  assert.match(html, /<div class="peligro aviso"><div class="cifra">(19|20|21) min<\/div><div><strong>sin ningún empuje a <code>origin\/main<\/code>, desde las \d\d:\d\d, con 1 commit de hoy esperando\.<\/strong> Es MAYOR que lo habitual\./)
  assert.match(html, /percentil 95 de los huecos entre empujes de un mismo día es 5 min \(n = 60 huecos, 9 días con empujes desde el 2026-01-01; umbral calculado el \d{4}-\d\d-\d\d\)/)

  guardar(60)
  ;({ datos, html } = await correr(e, { ahora: en20 }))
  assert.deepEqual(deTipo(datos, 'hueco'), [])
  assert.match(html, /<div class="nota aviso"><div class="cifra">(19|20|21) min<\/div>/)

  // Sin umbral guardado se calcula del reflog de este clon y se guarda con su fecha; con n < 40 no hay P95 ni aviso.
  fs.rmSync(`${e.salida}/umbrales.json`)
  ;({ datos, html } = await correr(e, { ahora: en20 }))
  assert.deepEqual(deTipo(datos, 'hueco'), [])
  assert.match(html, /n = 0 huecos entre empujes en el reflog de este clon, insuficiente para un percentil 95 \(hacen falta 40\)/)
  const guardado = JSON.parse(fs.readFileSync(`${e.salida}/umbrales.json`, 'utf8'))[e.raiz.toLowerCase()]
  assert.deepEqual([guardado.calculado, guardado.n, guardado.p95_min], [indice.diaLocal(en20), 0, null])
})

test('commits escritos y sin llegar a origin/main: total, por rama y el más viejo; y el gráfico de hoy cuenta los que ya llegaron', async t => {
  if (cercaDeMedianoche()) return t.skip('a menos de una hora de la medianoche local el «hoy» de la prueba cambia a mitad')
  const e = escenario()
  confirmar(e.agy, 'uno.txt', 'x\n')
  confirmar(e.agy, 'dos.txt', 'x\n')
  confirmar(e.codex, 'tres.txt', 'x\n')
  // Uno que ya llegó: se escribe en main y se empuja.
  confirmar(e.raiz, 'cuatro.txt', 'x\n')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  const { datos, html } = await correr(e, { ahora: Date.now() + 20 * MINUTO })
  const g = datos.repositorios[0].integracion
  assert.equal(g.medido, true)
  assert.equal(g.sin_integrar.total, 3)
  assert.equal(g.sin_integrar.de_hoy, 3)
  assert.equal(g.sin_integrar.ramas_miradas, 3)
  assert.deepEqual(g.sin_integrar.por_rama.map(x => [x.rama, x.commits]).sort(), [['agy/12', 2], ['codex/34', 1]])
  assert.ok(g.sin_integrar.por_rama.every(x => typeof x.mas_viejo_ms === 'number'))
  assert.equal(g.empujes_hoy, 2, 'el empuje inicial y el de ahora')
  assert.equal(g.hoy.pico.pendientes, 3)
  assert.equal(g.hoy.empujes.length, 2)
  assert.match(html, /<div class="cifra">3 commits<\/div><div><strong>escritos y sin llegar a <code>origin\/main<\/code>; 3 de 3 son de hoy/)
  assert.match(html, /n = 3 ramas locales miradas, cada commit contado una vez/)
  assert.match(html, /<td><code>agy\/12<\/code><\/td><td class="num">2<\/td>/)
  assert.match(html, /Cifras: máximo de 3 commits a las \d\d:\d\d; 2 empujes hoy/)
  assert.match(fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8'), /Sin integrar: 3 commits escritos y sin llegar a origin\/main \(3 de hoy\); 2 empujes hoy/)
})

test('issues abiertas que no pueden avanzar solas: «k de n» por causa con credencial; sin ella, NO MEDIDO', async () => {
  const e = escenario({ estado: { cola: [1, 2], declarado: { 1: { espera: 'Motivo-Apio que no sale' } } } })
  const nodo = (number, ...etiquetas) => ({ number, labels: { nodes: etiquetas.map(name => ({ name })) } })
  const abiertas = [nodo(1, 'bloqueada'), nodo(2, 'Bloqueada'), nodo(3, 'peso:XL'), nodo(4, 'peso:M'), nodo(5), nodo(6, 'épica', 'bloqueada'), nodo(7, 'decision-humana')]
  const g = github(e, [
    ['api.github.com/user', { status: 200, texto: '{}' }],
    ['api.github.com/graphql', { status: 200, texto: JSON.stringify({ data: { repository: { issues: { totalCount: 7, nodes: abiertas } }, search: { issueCount: 0 } } }) }],
  ])
  let { datos, html, json } = await correr(e, { raices: undefined, pedir: g.pedir })
  assert.deepEqual(datos.repositorios[0].github.no_avanzan, { total: 4, denominador: 6, espera: 1, etiqueta: 2, xl: 1, miradas: 7, abiertas: 7 })
  assert.match(html, /<div class="cifra">4 de 6<\/div><div><strong>issues abiertas no pueden avanzar solas:<\/strong> 1 con espera declarada, 2 con etiqueta de bloqueo o de decisión, 1 de peso XL sin partir\./)
  assert.match(html, /Denominador: las 6 abiertas que no son épica, de 7 leídas/)
  assert.equal((html + json).includes('Apio'), false)
  // La consulta no pide títulos.
  assert.ok(g.pedidas.some(p => p.url.endsWith('/graphql')))

  const sin = escenario()
  ;({ datos, html } = await correr(sin))
  assert.equal(datos.repositorios[0].github.no_avanzan, null)
  assert.match(html, /<div class="cifra"><span class="nm">NO MEDIDO<\/span> <span class="pie">el repositorio no declara credencial de GitHub<\/span><\/div><div><strong>issues abiertas que no pueden avanzar solas/)
})

test('una espera declarada cuya rama ya llegó a origin/main: cuello medio «lo declarado está caducado»; con la rama aún por delante, o sin commits suyos, no', async () => {
  const e = escenario({ estado: { cola: [12, 34], declarado: { 12: { espera: 'credencial' }, 34: { espera: 'credencial' } } } })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  // codex/34 no tiene ningún commit suyo: su rama «está» en main, pero nada de la #34 llegó.
  confirmar(e.agy, 'arreglo.txt', 'x\n', 'arregla el formulario (#12)')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'caducado'), [], 'la rama de la #12 aún va por delante')

  git(e.raiz, 'merge', '-q', '--ff-only', 'agy/12')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  let html
  ;({ datos, html } = await correr(e))
  const cuellos = deTipo(datos, 'caducado')
  assert.equal(cuellos.length, 1)
  assert.equal(cuellos[0].gravedad, 'media')
  assert.match(cuellos[0].que, /Lo declarado está caducado: la #12 figura en espera y su rama ya llegó a origin\/main/)
  assert.deepEqual(datos.repositorios[0].control.esperas_caducadas, [12])
  assert.match(html, /CADUCADA: su rama ya llegó a la principal/)
})

test('incidentes de coordinación: cuántos hoy y cuántos de una causa que se repite, sin la frase libre; sin fichero, NO MEDIDO', async () => {
  const e = escenario()
  const hoy = indice.diaLocal(Date.now())
  escribir(e.raiz, '.claude/incidentes.tsv', ['# fecha\thora\tcausa\tcoste_min\tdeteccion\trecurso\tissue\tque', `${hoy}\t09:45\tbloqueo\t141\tauto\tcredencial\t12\tFrase-Coliflor que no sale`, `${hoy}\t?\treserva\t?\tauto\tmigracion\t34\tFrase-Coliflor dos`, `${hoy}\t?\treserva\t?\tanotado\tarbol\t-\tFrase-Coliflor tres`, '2026-01-02\t?\taviso\t12\tanotado\tmain\t-\tde otro día', ''].join('\n'))
  let { datos, html, json } = await correr(e)
  assert.deepEqual(datos.repositorios[0].incidentes, { hoy: 3, en_causa_repetida: 2, por_causa: [{ causa: 'reserva', n: 2 }, { causa: 'bloqueo', n: 1 }], coste_min: 141, con_coste: 1, detectados_solos: 2, dias_con_registro: 2, dia_cerrado: false })
  assert.match(html, /<div class="cifra">3 hoy<\/div><div><strong>incidentes de coordinación registrados; 2 de 3 son de una causa que se repitió en el día\.<\/strong>/)
  assert.match(html, /n = 2 días de registro: es una línea base, no una tasa/)
  assert.match(html, /<td>reserva<\/td><td class="num">2<\/td>/)
  assert.match(html, /coste medido: 141 min en 1 de 3; en los otros 2, <span class="nm">NO MEDIDO<\/span>/)
  assert.equal((html + json + fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8')).includes('Coliflor'), false)

  // Cero incidentes con la línea de cierre: se miró y no hubo. Sin ella, se dice que quizá nadie miró.
  escribir(e.raiz, '.claude/incidentes.tsv', `${hoy}\t-\tcierre\t-\t-\t-\t-\tdía revisado\n`)
  ;({ datos, html } = await correr(e))
  assert.equal(datos.repositorios[0].incidentes.hoy, 0)
  assert.match(html, /<div class="cifra">0 hoy<\/div>[\s\S]{0,300}el día tiene su línea de cierre: se miró y no hubo/)

  const sin = escenario()
  ;({ datos, html } = await correr(sin))
  assert.equal(datos.repositorios[0].incidentes, null)
  assert.match(html, /<span class="nm">NO MEDIDO<\/span> <span class="pie">el repositorio no tiene registro de incidentes \(\.claude\/incidentes\.tsv\)<\/span><\/div><div><strong>incidentes de coordinación hoy/)
})

test('la carpeta de migraciones es configurable, y sin carpeta no hay nada que medir', async () => {
  const e = escenario()
  confirmar(e.agy, 'esquema/cambios/0007_a.sql', '-- a\n')
  confirmar(e.codex, 'esquema/cambios/0007_b.sql', '-- b\n')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'migracion'), [])
  ;({ datos } = await correr(e, { config: { migraciones: 'esquema/cambios' } }))
  assert.equal(deTipo(datos, 'migracion').length, 1)
  ;({ datos } = await correr(e, { config: { migraciones: 'no/existe' } }))
  assert.equal(datos.repositorios[0].migraciones.existe, false)
})

test('remoto movido bajo un árbol con trabajo: cuello alto; movido sin trabajo debajo o sin moverse, no', async () => {
  const e = escenario()
  moverRemoto(e)
  let { datos } = await correr(e)
  assert.equal(datos.repositorios[0].origen.remoto_movido, true)
  assert.deepEqual(deTipo(datos, 'remoto'), [], 'movido, pero nadie tiene trabajo debajo')

  escribir(e.agy, 'a-medias.txt', 'x\n')
  ;({ datos } = await correr(e))
  const [c] = deTipo(datos, 'remoto')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /agy\/12/)

  // Traído el remoto (lo hace la prueba; el guion nunca hace fetch), deja de estar movido.
  git(e.raiz, 'fetch', '-q', 'origin')
  ;({ datos } = await correr(e))
  assert.equal(datos.repositorios[0].origen.remoto_movido, false)
  assert.deepEqual(deTipo(datos, 'remoto'), [])
  assert.equal(datos.repositorios[0].origen.por_detras.length, 3, 'los tres árboles quedan por detrás de origin/main')
})

test('con --sin-red el remoto queda «sin medir» y no se pide nada', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  moverRemoto(e)
  let pedidas = 0
  const { datos } = await correr(e, { sinRed: true, pedir: async () => (pedidas++, { status: 200, texto: '{}' }), config: { credencial: { fichero: '.env', variable: 'X' } } })
  assert.equal(pedidas, 0)
  assert.equal(datos.repositorios[0].origen.remoto, 'sin medir')
  assert.equal(datos.repositorios[0].origen.remoto_movido, null)
  assert.equal(datos.repositorios[0].produccion.estado, 'sin medir')
  assert.equal(datos.repositorios[0].github.issues_abiertas, 'sin medir')
  assert.equal(fs.readdirSync(e.salida).some(f => f.startsWith('produccion-')), false, 'sin medir no hay ficha pública')
})

test('stash en la rama de un agente: cuello medio; sin stash, no', async () => {
  const e = escenario()
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'stash'), [])
  fs.appendFileSync(path.join(e.agy, 'LEEME.txt'), 'a medias\n')
  git(e.agy, 'stash')
  ;({ datos } = await correr(e))
  const [c] = deTipo(datos, 'stash')
  assert.equal(c.gravedad, 'media')
  assert.match(c.que, /agy\/12 tiene 1 entrada en el stash/)
  assert.equal(datos.repositorios[0].arboles.find(a => a.rama === 'agy/12').stash, 1)
  assert.equal(datos.repositorios[0].arboles.find(a => a.rama === 'codex/34').stash, 0)
})

test('trabajo sin confirmar hace más de 30 min sin commit: cuello medio que no dice «inactivo»; reciente o limpio, no', async () => {
  const e = escenario()
  escribir(e.agy, 'src/a-medias.ts', 'export {}\n')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'sin-confirmar'), [], 'el último commit es de hace menos de 30 min')
  const arbol = datos.repositorios[0].arboles.find(a => a.rama === 'agy/12')
  assert.equal(arbol.sin_confirmar, 1)
  assert.match(arbol.mas_reciente.fichero, /a-medias\.ts|^src\/$/)

  ;({ datos } = await correr(e, { ahora: en40() }))
  const cuellos = deTipo(datos, 'sin-confirmar')
  assert.equal(cuellos.length, 1)
  assert.equal(cuellos[0].gravedad, 'media')
  assert.match(cuellos[0].que, /agy \(agy\/12\) tiene trabajo sin confirmar/)
  assert.match(cuellos[0].que, /No significa que esté parado/)
  assert.doesNotMatch(JSON.stringify(datos.cuellos), /inactiv/i)
  // Un árbol con trabajo sin confirmar no es una pieza terminada.
  assert.deepEqual(deTipo(datos, 'pieza'), [])
})

test('pieza terminada sin integrar hace más de 30 min: cuello medio que dice cuánto espera; recién confirmada, no', async () => {
  const e = escenario()
  confirmar(e.codex, 'pieza.txt', 'lista\n')
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'pieza'), [])
  ;({ datos } = await correr(e, { ahora: en40() }))
  const [c] = deTipo(datos, 'pieza')
  assert.equal(c.gravedad, 'media')
  assert.match(c.que, /codex \(codex\/34\) lleva 1 commits por delante de origin\/main, árbol limpio, esperando hace 4\d min/)
  assert.match(c.desde, /UTC$/)
})

test('el control: quién tiene cada issue según lo declarado; su edad se muestra sin alarma', async () => {
  const e = escenario({ estado: { cola: [12], fuera: { codex: 'sin cuota' }, declarado: { 12: { pasos: [{ paso: 'primero', hecho: true }, { paso: 'validar el formulario', hecho: false }] } } } })
  const local = escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  const hace45 = new Date(Date.now() - 45 * MINUTO)
  fs.utimesSync(local, hace45, hace45)
  const { datos, html } = await correr(e)
  const c = datos.repositorios[0].control
  assert.deepEqual(c.asignaciones, [{ issue: 12, trabajador: 'agy', quien: 'Agy', estado: 'vigente', paso: 'validar el formulario', espera: false }])
  assert.deepEqual(c.fuera, ['codex'])
  // El control sólo reescribe cuando su decisión cambia: 45 minutos sin escribirse no es un cuello de botella.
  assert.deepEqual(datos.cuellos, [])
  assert.match(html, /última decisión escrita: <span title="[^"]+">hace 45 min<\/span> \(el control sólo reescribe cuando su decisión cambia: la edad sola no indica nada\)/)
  assert.doesNotMatch(html, /desfasado/i)
})

test('una issue con trabajo en dos árboles: aviso medio que pregunta; alto sólo si los dos tocaron los mismos ficheros', async () => {
  const e = escenario({ estado: { cola: [12] } })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  let { datos } = await correr(e)
  assert.deepEqual(deTipo(datos, 'duplicada'), [], 'el control y la rama dicen lo mismo: agy')

  // Otro agente abre su propio árbol sobre la misma issue y toca OTROS ficheros.
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'codex/12', `${e.dir}/plataforma-codex-12`)
  confirmar(e.agy, 'src/formulario.ts', 'export const a = 1\n')
  confirmar(`${e.dir}/plataforma-codex-12`, 'src/otra-cosa.ts', 'export const b = 1\n')
  ;({ datos } = await correr(e))
  let [c] = deTipo(datos, 'duplicada')
  assert.equal(c.gravedad, 'media')
  assert.equal(c.que, 'La #12 tiene trabajo en dos árboles (agy/12 y codex/12): confirmar que el reparto es intencionado.')
  assert.equal(deTipo(datos, 'duplicada').length, 1)

  // Ahora los dos tocan el mismo fichero: eso sí es grave, y se dice cuál.
  confirmar(`${e.dir}/plataforma-codex-12`, 'src/formulario.ts', 'export const a = 2\n')
  ;({ datos } = await correr(e))
  ;[c] = deTipo(datos, 'duplicada')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /La #12 tiene trabajo en dos árboles \(agy\/12 y codex\/12\) y los dos tocaron los mismos ficheros: src\/formulario\.ts\. Hay que repartirlo antes de integrar\./)
  assert.deepEqual(datos.repositorios[0].repartidas[0].ficheros_comunes, ['src/formulario.ts'])

  // Si una rama contiene entera a la otra, coincidir en ficheros no es un choque.
  git(`${e.dir}/plataforma-codex-12`, 'merge', '-q', '-m', 'trae lo de agy', '-X', 'ours', 'agy/12')
  ;({ datos } = await correr(e))
  assert.equal(deTipo(datos, 'duplicada')[0].gravedad, 'media')
})

test('una rama antigua sin asignación vigente no genera ningún aviso ni sale en la tabla: va a una lista cerrada', async () => {
  const estado = { cola: [12], herramientas: {} }
  const e = escenario({ estado })
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  confirmar(e.codex, 'db/migrations/0002_de_codex.sql', '-- c\n')
  fs.appendFileSync(path.join(e.agy, 'LEEME.txt'), 'guardado\n')
  git(e.agy, 'stash')
  escribir(e.codex, 'a-medias.txt', 'x\n')
  // Hoy: son ramas vivas y avisan (número repetido, pieza con stash, trabajo sin confirmar).
  let { datos, html } = await correr(e, { ahora: en40(), sinRed: true })
  assert.deepEqual(datos.cuellos.map(c => c.tipo).sort(), ['migracion', 'pieza', 'sin-confirmar'])
  assert.match(deTipo(datos, 'pieza')[0].que, /agy \(agy\/12\) lleva 1 commits por delante.*; además tiene 1 entrada en el stash\./)
  assert.deepEqual(datos.repositorios[0].antiguas, [])
  assert.doesNotMatch(html, /Ramas antiguas/)

  // Veinte días después, sin tocarlas: ni un aviso, fuera de la tabla, y listadas aparte con su antigüedad.
  const en20dias = Date.now() + 20 * 24 * 60 * MINUTO
  ;({ datos, html } = await correr(e, { ahora: en20dias, sinRed: true }))
  assert.deepEqual(datos.cuellos, [])
  assert.deepEqual(datos.repositorios[0].arboles.map(a => a.rama), ['main'])
  assert.deepEqual(datos.repositorios[0].antiguas.map(x => [x.rama, x.dias, x.delante, x.con_arbol, x.stash, x.sin_confirmar]), [['agy/12', 20, 1, true, 1, 0], ['codex/34', 20, 1, true, 0, 1]])
  assert.deepEqual(datos.repositorios[0].migraciones.tomados, [])
  assert.equal(datos.repositorios[0].integracion.sin_integrar.total, 0)
  assert.match(html, /<details>\n<summary>Ramas antiguas \(2\): último commit hace más de 14 días y sin asignación vigente\. No generan avisos\.<\/summary>/)
  assert.match(html, /<li><code>agy\/12<\/code> · último commit hace 20 días · \+1 \/ −0 commits respecto de la principal · con árbol · 1 entrada en el stash<\/li>/)
  assert.doesNotMatch(html, /<details open/)
  const tabla = html.slice(html.indexOf('Medido · git y disco'), html.indexOf('Medido · migraciones'))
  assert.doesNotMatch(tabla.slice(0, tabla.indexOf('<details>')), /agy\/12|codex\/34/)

  // Con una asignación vigente del control sobre la #12, esa rama no es antigua por vieja que sea.
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  ;({ datos } = await correr(e, { ahora: en20dias, sinRed: true }))
  assert.deepEqual(datos.repositorios[0].arboles.map(a => a.rama), ['main', 'agy/12'])
  assert.deepEqual(datos.repositorios[0].antiguas.map(x => x.rama), ['codex/34'])
  assert.ok(deTipo(datos, 'pieza').length === 1)
  fs.rmSync(`${e.raiz}/.claude/orquestacion.local.json`)

  // El umbral es configurable: con 30 días, ninguna es antigua todavía.
  ;({ datos } = await correr(e, { ahora: en20dias, sinRed: true, config: { dias_rama_antigua: 30 } }))
  assert.deepEqual(datos.repositorios[0].antiguas, [])
  assert.equal(deTipo(datos, 'migracion').length, 1)
})

test('el árbol principal por delante sólo avisa por los commits de hoy', async t => {
  if (cercaDeMedianoche()) return t.skip('a menos de una hora de la medianoche local el «hoy» de la prueba cambia a mitad')
  const e = escenario()
  confirmar(e.raiz, 'sin-empujar.txt', 'x\n')
  let { datos } = await correr(e, { ahora: en40(), sinRed: true })
  const [c] = deTipo(datos, 'pieza')
  assert.match(c.que, /^main local lleva 1 commit de hoy sin empujar a origin\/main; el último, hace 4\d min\.$/)
  // El mismo commit, visto dos días después: ya no es de hoy, y no avisa.
  ;({ datos } = await correr(e, { ahora: Date.now() + 2 * 24 * 60 * MINUTO, sinRed: true }))
  assert.deepEqual(deTipo(datos, 'pieza'), [])
})

test('la tabla «Quién está en qué»: el estado primero, cabeceras cortas, anchos fijos y celdas de una línea', async () => {
  const e = escenario({ estado: { cola: [34] } })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 34: { trabajador: 'codex', estado: 'vigente' } } }))
  escribir(e.agy, 'src/a-medias.ts', 'x\n')
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'integracion/prueba', `${e.dir}/plataforma-integra`)
  const { html } = await correr(e, { ahora: en40(), sinRed: true })
  const tabla = html.slice(html.indexOf('Medido · git y disco'), html.indexOf('Medido · migraciones'))
  assert.match(tabla, /<table class="fija">\n<colgroup>(<col style="width:\d+%">){8}<\/colgroup>\n<tr><th>Estado medido<\/th><th>Trabajador<\/th><th class="num">Issue<\/th><th>Rama<\/th><th>Último commit<\/th><th class="num">Sin confirmar<\/th><th class="num">Stash<\/th><th class="num">Respecto de la principal<\/th><\/tr>/)
  const anchos = [...tabla.matchAll(/<col style="width:(\d+)%">/g)].map(m => Number(m[1]))
  assert.equal(anchos.reduce((a, b) => a + b, 0), 100)
  assert.ok(anchos[0] === Math.max(...anchos), 'la columna de estado es la más ancha')
  assert.match(html, /table\.fija\{table-layout:fixed;min-width:860px\}/)
  // Una fila: estado · trabajador · issue · rama · último commit (sólo hace cuánto; el asunto en title) · sin confirmar en una línea.
  assert.match(tabla, /<tr><td>■ <strong>tiene trabajo a medias<\/strong><\/td><td>agy<\/td><td class="num">#12<\/td><td><code>agy\/12<\/code><\/td><td><span title="primer commit · [^"]+ UTC">hace 40 min<\/span><\/td><td class="num"><span title="el más reciente: src\/[^"]*">1 · hace 40 min<\/span><\/td><td class="num">—<\/td><td class="num">\+0 \/ −0<\/td><\/tr>/)
  assert.doesNotMatch(tabla, /primer commit<\/td>|<br>/, 'el asunto del commit no va en la celda')
  // Sin trabajador ni issue: «—» en las dos, no «sin identificar».
  assert.match(tabla, /<td>—<\/td><td class="num">—<\/td><td><code>integracion\/prueba<\/code><\/td>/)
  assert.doesNotMatch(tabla, /sin identificar|sin issue en la rama/)
  // Primero quien tiene asignación vigente o actividad reciente, por lo que más espera.
  assert.ok(tabla.indexOf('<code>agy/12</code>') < tabla.indexOf('<code>main</code>'))
})

// ── Credencial, GitHub y producción, sin red ────────────────────────────────────────────────────────

const SECRETO = 'ghp_SecretoDePrueba0123456789abcdefXYZ'

function github(e, respuestas) {
  escribir(e.raiz, '.env', `OTRA=1\nexport TOKEN_DE_PRUEBA="${SECRETO}"\n`)
  fs.writeFileSync(`${e.salida}/repositorios.json`, JSON.stringify({ repositorios: [{ raiz: e.raiz, repo: 'acme/plataforma', credencial: { fichero: '.env', variable: 'TOKEN_DE_PRUEBA' } }] }))
  const pedidas = []
  const pedir = async (url, init = {}) => {
    pedidas.push({ url, autorizacion: init.headers?.authorization ?? null })
    for (const [patron, respuesta] of respuestas) if (url.includes(patron)) return typeof respuesta === 'function' ? respuesta(url, init) : respuesta
    return { status: 0, texto: '' }
  }
  return { pedidas, pedir }
}

async function porLaOrden(e, pedir, extra = []) {
  const dicho = []
  const [log, error] = [console.log, console.error]
  console.log = (...a) => dicho.push(a.join(' '))
  console.error = (...a) => dicho.push(a.join(' '))
  try {
    const codigo = await indice.principal(['--salida', e.salida, ...extra], { pedir })
    return { codigo, salidaEstandar: dicho.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

test('credencial rechazada: cuello alto, y el valor no aparece en index.json, en index.html ni en la salida estándar', async () => {
  const e = escenario()
  const { pedidas, pedir } = github(e, [['api.github.com/user', { status: 401, texto: `{"message":"Bad credentials ${SECRETO}"}` }]])
  const { codigo, salidaEstandar } = await porLaOrden(e, pedir)
  assert.equal(codigo, 0)
  const json = fs.readFileSync(`${e.salida}/index.json`, 'utf8')
  const datos = JSON.parse(json)
  const [c] = deTipo(datos, 'credencial')
  assert.equal(c.gravedad, 'alta')
  assert.equal(datos.repositorios[0].github.credencial.estado, 'rechazada (401)')
  assert.match(datos.repositorios[0].github.credencial.cuando, /UTC$/)
  assert.equal(datos.repositorios[0].github.issues_abiertas, 'sin medir')
  assert.deepEqual(pedidas.map(p => p.url), ['https://api.github.com/user'], 'rechazada: no se pide nada más con ella')
  assert.equal(pedidas[0].autorizacion, `Bearer ${SECRETO}`, 'la prueba sí usó el valor: lo que sigue no pasa por casualidad')
  for (const f of fs.readdirSync(e.salida)) assert.equal(fs.readFileSync(path.join(e.salida, f), 'utf8').includes(SECRETO), false, `${f} lleva el valor de la credencial`)
  for (const f of ['PIZARRA.md', 'pizarra.json']) assert.equal(fs.readFileSync(path.join(e.raiz, '.git', 'consumo', f), 'utf8').includes(SECRETO), false)
  assert.equal(salidaEstandar.includes(SECRETO), false)
  assert.equal(json.includes('TOKEN_DE_PRUEBA'), false, 'tampoco el nombre de la variable')
  assert.match(salidaEstandar, /1 cuellos de botella/)
})

test('credencial vigente: issues abiertas, cerradas hoy y despliegue medidos; el valor sólo viaja a api.github.com y no se escribe', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  const sha = git(e.raiz, 'rev-parse', 'origin/main')
  const { pedidas, pedir } = github(e, [
    ['api.github.com/user', { status: 200, texto: '{"login":"acme"}' }],
    ['api.github.com/graphql', { status: 200, texto: JSON.stringify({ data: { repository: { issues: { totalCount: 17 } }, search: { issueCount: 3 } } }) }],
    [`/repos/acme/plataforma/commits/${sha}/status`, { status: 200, texto: JSON.stringify({ state: 'success', total_count: 1 }) }],
    ['ejemplo.invalid/health', { status: 200, texto: JSON.stringify({ status: 'ok', commit: sha }) }],
  ])
  const { salidaEstandar } = await porLaOrden(e, pedir)
  const datos = JSON.parse(fs.readFileSync(`${e.salida}/index.json`, 'utf8'))
  const g = datos.repositorios[0].github
  assert.deepEqual([g.credencial.estado, g.issues_abiertas, g.cerradas_hoy, g.despliegue.estado], ['vigente', 17, 3, 'success'])
  assert.deepEqual(datos.cuellos, [])
  assert.equal(pedidas.length, 4)
  for (const p of pedidas) assert.equal(p.autorizacion !== null, p.url.startsWith('https://api.github.com/'), `autorización indebida en ${p.url}`)
  for (const f of fs.readdirSync(e.salida)) assert.equal(fs.readFileSync(path.join(e.salida, f), 'utf8').includes(SECRETO), false)
  assert.equal(salidaEstandar.includes(SECRETO), false)
})

test('sin credencial declarada, GitHub queda «sin medir» y no se le pide nada', async () => {
  const e = escenario()
  const pedidas = []
  const { datos } = await correr(e, { pedir: async url => (pedidas.push(url), { status: 200, texto: '{}' }) })
  const g = datos.repositorios[0].github
  assert.deepEqual([g.credencial.estado, g.issues_abiertas, g.cerradas_hoy, g.despliegue.estado], ['sin declarar', 'sin medir', 'sin medir', 'sin medir'])
  assert.deepEqual(pedidas, [])
  assert.deepEqual(deTipo(datos, 'credencial'), [])
})

test('último commit de main sin despliegue tras 10 minutos: cuello alto; recién empujado o desplegado, no', async () => {
  const e = escenario()
  const sinDespliegue = [['api.github.com/user', { status: 200, texto: '{}' }], ['/status', { status: 200, texto: JSON.stringify({ state: 'pending', total_count: 0 }) }]]
  let g = github(e, sinDespliegue)
  let { datos } = await correr(e, { raices: undefined, pedir: g.pedir })
  assert.equal(datos.repositorios[0].github.despliegue.estado, 'sin despliegue')
  assert.deepEqual(deTipo(datos, 'despliegue'), [], 'aún no pasan 10 minutos')

  ;({ datos } = await correr(e, { raices: undefined, pedir: g.pedir, ahora: Date.now() + 15 * MINUTO }))
  const [c] = deTipo(datos, 'despliegue')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /sin despliegue/)

  g = github(e, [['api.github.com/user', { status: 200, texto: '{}' }], ['/status', { status: 200, texto: JSON.stringify({ state: 'success', total_count: 2 }) }]])
  ;({ datos } = await correr(e, { raices: undefined, pedir: g.pedir, ahora: Date.now() + 15 * MINUTO }))
  assert.deepEqual(deTipo(datos, 'despliegue'), [])
})

test('producción con otro commit que main, o con problemas: cuello alto; con el commit de main y bien, no', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  const sha = git(e.raiz, 'rev-parse', 'origin/main')
  const salud = cuerpo => async () => ({ status: 200, texto: JSON.stringify(cuerpo) })

  let { datos } = await correr(e, { pedir: salud({ status: 'ok', commit: sha.slice(0, 10) }) })
  assert.deepEqual(deTipo(datos, 'produccion'), [])
  assert.equal(datos.repositorios[0].produccion.coincide, true)

  ;({ datos } = await correr(e, { pedir: salud({ status: 'ok', commit: 'abcdef1234' }) }))
  assert.equal(deTipo(datos, 'produccion').length, 1)
  assert.match(deTipo(datos, 'produccion')[0].que, /Producción corre abcdef1234/)

  ;({ datos } = await correr(e, { pedir: salud({ status: 'caido', commit: sha }) }))
  assert.match(deTipo(datos, 'produccion')[0].que, /con problemas/)
  assert.equal(deTipo(datos, 'produccion')[0].gravedad, 'alta')
})

// ── Privacidad ──────────────────────────────────────────────────────────────────────────────────────

const ESTADO_CON_TITULOS = {
  cola: [12, 7002],
  fuera: { codex: 'Motivo-Rabanito que no debe salir' },
  declarado: { 12: { falta: 'Pepinillo reconocible en lo que falta', espera: 'Alcachofa reconocible en la espera', pasos: [{ paso: 'paso visible', hecho: false }] } },
  clasificacion: [{ numero: 12, titulo: 'Zanahoria reconocible en el titulo' }],
  produccion: { salud: 'https://ejemplo.invalid/health' },
}

test('el index no lleva títulos de issues ni contenido de ficheros, aunque el estado los tenga', async () => {
  const e = escenario({ estado: ESTADO_CON_TITULOS })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente', encargo: 'Encargo: Berenjena reconocible' } }, clasificacion: [{ numero: 7002, titulo: 'Berenjena reconocible en la cola' }] }))
  escribir(e.agy, 'notas.txt', 'Contenido-Remolacha que no debe salir\n')
  const { json, html } = await correr(e, { ahora: en40(), pedir: async () => ({ status: 200, texto: '{"status":"ok","commit":"abcdef1234"}' }) })
  const pizarra = fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8') + fs.readFileSync(`${e.raiz}/.git/consumo/pizarra.json`, 'utf8')
  for (const salida of [json, html, pizarra]) {
    for (const prohibido of ['Zanahoria', 'Berenjena', 'Pepinillo', 'Alcachofa', 'Rabanito', 'Remolacha', 'reconocible', '7002']) assert.equal(salida.includes(prohibido), false, `sale «${prohibido}»`)
  }
  // Lo que sí lleva: número, trabajador, paso y nombre de fichero.
  assert.match(html, /<td class="num">#12<\/td><td>Agy<\/td><td>paso visible<\/td><td>vigente · ■ espera al dueño<\/td>/)
  assert.match(html, /notas\.txt/)
})

test('la ficha pública de producción sólo tiene commit y salud', async () => {
  const e = escenario({ estado: ESTADO_CON_TITULOS })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  await correr(e, { pedir: async () => ({ status: 200, texto: JSON.stringify({ status: 'ok', commit: 'ABCDEF1234', version: '9.9.9', entorno: 'produccion' }) }) })
  const json = fs.readFileSync(`${e.salida}/produccion-plataforma.json`, 'utf8')
  const html = fs.readFileSync(`${e.salida}/produccion-plataforma.html`, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['bien', 'commit', 'foto'])
  assert.equal(JSON.parse(json).commit, 'abcdef1234')
  assert.equal(JSON.parse(json).bien, true)
  for (const salida of [json, html]) for (const prohibido of ['#12', 'agy', 'Agy', 'main', 'paso', 'plataforma', '9.9.9', 'entorno', 'ejemplo.invalid', 'cuello']) assert.equal(salida.includes(prohibido), false, `la ficha pública lleva «${prohibido}»`)
  assert.doesNotMatch(html, /<script|refresh/)
  // La función que la arma recibe sólo { commit, bien, cuando }: lo demás que se le pase no sale.
  const colado = indice.fichaDeProduccion({ commit: 'abcdef1234', bien: true, cuando: 0, cuellos: ['Zanahoria'], repositorios: ['Zanahoria'] })
  assert.equal((colado.html + colado.json).includes('Zanahoria'), false)
  assert.equal(indice.fichaDeProduccion.length, 1)
})

// ── Lo portado no se separa de hooks/indice.ts ──────────────────────────────────────────────────────

test('lo portado a .mjs da lo mismo que hooks/indice.ts sobre el mismo estado', async t => {
  if (typeof module.stripTypeScriptTypes !== 'function') return t.skip('este Node no trae module.stripTypeScriptTypes (hace falta 22.13 o posterior)')
  const dir = carpetaTemporal('ts')
  for (const nombre of ['router', 'indice']) {
    const fuente = fs.readFileSync(path.join(aqui, '..', 'hooks', `${nombre}.ts`), 'utf8')
    fs.writeFileSync(`${dir}/${nombre}.mjs`, module.stripTypeScriptTypes(fuente).replace(/from '\.\/router'/g, "from './router.mjs'"))
  }
  const ts = await import(pathToFileURL(`${dir}/indice.mjs`).href)
  for (const s of [{ commit: 'abcdef1234', bien: true, cuando: 1_780_000_000_000 }, { commit: null, bien: false, cuando: 0 }, { commit: 'NO-ES-UN-SHA', bien: true, cuando: 5 }]) {
    assert.deepEqual(indice.fichaDeProduccion(s), ts.fichaDeProduccion(s))
  }
  for (const r of ['{"status":"ok","commit":"ABCDEF12"}', '{"ok":true}', '{"estado":" OK ","commit":"zzz"}', 'no es json', '', '[]', 'null']) assert.deepEqual(indice.saludDe(r), ts.saludDe(r))
  for (const n of ['Plataforma Añil', '  ', 'acme/plataforma', 'a'.repeat(90)]) assert.equal(indice.nombreDeArchivo(n), ts.nombreDeArchivo(n))
  for (const est of [null, {}, { produccion: { salud: 'https://ejemplo.invalid/health' } }, { produccion: { salud: '-o fichero' } }, { produccion: { salud: 'ftp://x' } }]) assert.equal(indice.urlDeSalud(est), ts.urlDeSalud(est))
  assert.equal(indice.instante(1_780_000_000_000), ts.instante(1_780_000_000_000))
  assert.equal(indice.SIN_PASO, ts.SIN_PASO)
  // La issue en curso: quién la tiene y su paso sin hacer, igual en la ficha del mod que en el control del guion.
  const estados = [
    { cola: [101], asignaciones: { 101: { trabajador: 'claude', estado: 'vigente' } }, declarado: { 101: { pasos: [{ paso: 'uno', hecho: true }, { paso: 'dos', hecho: false }] } } },
    { cola: [7], asignaciones: { 7: { trabajador: 'claude', estado: 'vigente' } } },
    { cola: [9], asignaciones: { 9: { trabajador: 'claude', estado: 'vigente' }, 12: { trabajador: 'agy', estado: 'vigente' } }, declarado: { 9: { pasos: [{ paso: 'hecho ya', hecho: true }] } } },
  ]
  for (const estado of estados) {
    const ficha = ts.ficha('acme', estado, null, 0)
    assert.equal(typeof ficha.issue, 'number', 'la ficha del mod tiene issue en curso: la comparación mide algo')
    const mio = indice.controlDe(estado).asignaciones.find(a => a.issue === ficha.issue)
    assert.deepEqual([mio.quien, mio.paso], [ficha.quien, ficha.paso])
  }
})

// ── Concurrencia, candado y sólo lectura ────────────────────────────────────────────────────────────

const lanzar = argumentos => new Promise(resolver => execFile(process.execPath, [GUION, ...argumentos], { env: entorno(), encoding: 'utf8' }, (error, stdout, stderr) => resolver({ codigo: error ? error.code : 0, stdout, stderr })))

test('dos corridas simultáneas no corrompen el fichero y las dos salen con 0', async () => {
  const e = escenario()
  const argumentos = ['--raiz', e.raiz, '--salida', e.salida, '--sin-red']
  const corridas = await Promise.all([lanzar(argumentos), lanzar(argumentos), lanzar(argumentos)])
  for (const c of corridas) assert.equal(c.codigo, 0, c.stderr)
  assert.ok(corridas.some(c => /cuellos de botella/.test(c.stdout)), 'al menos una midió')
  const datos = JSON.parse(fs.readFileSync(`${e.salida}/index.json`, 'utf8'))
  assert.equal(datos.repositorios[0].arboles.length, 3)
  assert.match(fs.readFileSync(`${e.salida}/index.html`, 'utf8'), /<\/html>\n$/)
  assert.deepEqual(fs.readdirSync(e.salida).filter(f => f.endsWith('.tmp') || f === '.indice.lock'), [], 'no quedan temporales ni candado')
})

test('con una corrida en marcha, la nueva sale sin hacer nada y con código 0; un candado viejo se toma', async () => {
  const e = escenario()
  fs.writeFileSync(`${e.salida}/.indice.lock`, '{}')
  let c = await lanzar(['--raiz', e.raiz, '--salida', e.salida, '--sin-red'])
  assert.equal(c.codigo, 0)
  assert.match(c.stdout, /ya hay una corrida en marcha/)
  assert.equal(fs.existsSync(`${e.salida}/index.json`), false)
  const viejo = new Date(Date.now() - 10 * MINUTO)
  fs.utimesSync(`${e.salida}/.indice.lock`, viejo, viejo)
  c = await lanzar(['--raiz', e.raiz, '--salida', e.salida, '--sin-red'])
  assert.equal(c.codigo, 0)
  assert.equal(fs.existsSync(`${e.salida}/index.json`), true)
})

test('el guion sólo lanza órdenes de git que leen, y no deja rastro en el repositorio que mide', async () => {
  const e = escenario()
  escribir(e.agy, 'a-medias.txt', 'x\n')
  const antes = fs.statSync(`${e.raiz}/.git/worktrees/plataforma-agy/index`).mtimeMs
  const refsAntes = git(e.raiz, 'for-each-ref')
  indice.ordenesDeGit.length = 0
  await correr(e, { sinPizarra: true })
  assert.ok(indice.ordenesDeGit.length > 5)
  for (const orden of indice.ordenesDeGit) assert.match(orden, /^(worktree list|status .*|for-each-ref .*|rev-parse .*|rev-list .*|ls-remote origin|ls-tree .*|stash list|log -1|reflog show|remote get-url|diff --name-only|diff --quiet)$/)
  await assert.rejects(indice.git(e.raiz, ['fetch', 'origin']), /no permitida/)
  await assert.rejects(indice.git(e.raiz, ['stash', 'pop']), /no permitida/)
  await assert.rejects(indice.git(e.raiz, ['worktree', 'prune']), /no permitida/)
  // «diff» sólo entre dos commits y sólo los nombres: nunca contra el árbol de trabajo.
  await assert.rejects(indice.git(e.raiz, ['diff', '--name-only']), /no permitida/)
  await assert.rejects(indice.git(e.raiz, ['diff', 'HEAD']), /no permitida/)
  assert.equal(fs.statSync(`${e.raiz}/.git/worktrees/plataforma-agy/index`).mtimeMs, antes, 'git status no refrescó el índice del árbol ajeno')
  assert.equal(git(e.raiz, 'for-each-ref'), refsAntes)
  assert.equal(fs.existsSync(`${e.raiz}/.git/consumo`), false, 'con --sin-pizarra no se escribe nada dentro del repositorio')
  assert.equal(git(e.raiz, 'status', '--porcelain'), '')
})

test('lanzado desde un hook (con GIT_DIR y GIT_INDEX_FILE de otro repositorio) mide el repositorio que se le pide', async () => {
  const e = escenario()
  const otro = escenario({ sinArboles: true })
  const guardado = { ...process.env }
  process.env.GIT_DIR = `${otro.raiz}/.git`
  process.env.GIT_INDEX_FILE = `${otro.raiz}/.git/index`
  process.env.GIT_WORK_TREE = otro.raiz
  try {
    const { datos } = await correr(e)
    assert.equal(datos.repositorios[0].arboles.length, 3)
  } finally {
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) if (guardado[k] === undefined) delete process.env[k]
  }
})

// ── Árboles efímeros, candado de suite y pizarra ────────────────────────────────────────────────────

test('los árboles de agentes efímeros se resumen; sólo salen en la tabla los que tuvieron actividad en dos horas', async () => {
  const e = escenario()
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'worktree-agente-1', `${e.raiz}/.claude/worktrees/agente-1`)
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'worktree-agente-2', `${e.raiz}/.claude/worktrees/agente-2`)
  escribir(`${e.raiz}/.claude/worktrees/agente-1`, 'suelto.txt', 'x\n')
  let { datos, html } = await correr(e)
  let r = datos.repositorios[0]
  const resumen = ef => ({ total: ef.total, con_cambios: ef.con_cambios, con_commits_por_delante: ef.con_commits_por_delante, activos_en_2h: ef.activos_en_2h, inactivos: ef.inactivos.length })
  assert.deepEqual(resumen(r.efimeros), { total: 2, con_cambios: 1, con_commits_por_delante: 0, activos_en_2h: 2, inactivos: 0 })
  assert.doesNotMatch(html, /<details>/)
  assert.equal(r.arboles.length, 5)
  assert.equal(r.arboles_vistos, 5)

  ;({ datos, html } = await correr(e, { ahora: Date.now() + 3 * 60 * MINUTO }))
  r = datos.repositorios[0]
  assert.deepEqual(resumen(r.efimeros), { total: 2, con_cambios: 1, con_commits_por_delante: 0, activos_en_2h: 0, inactivos: 2 })
  assert.deepEqual(r.arboles.map(a => a.rama), ['main', 'agy/12', 'codex/34'])
  assert.equal(r.arboles_vistos, 5)
  // Los inactivos van dentro de un <details> cerrado, con el recuento en el resumen.
  assert.match(html, /<details>\n<summary>2 árboles de agentes efímeros sin actividad en 2 h · 1 de 2 con cambios sin confirmar · 0 de 2 con commits por delante<\/summary>/)
  assert.doesNotMatch(html, /<details open/)
  // Un árbol efímero con trabajo viejo no es un cuello: se resume.
  assert.deepEqual(datos.cuellos.filter(c => /agente-1/.test(c.que)), [])
})

test('el candado de suite dice quién y desde cuándo, con nombre configurable, y no copia el fichero', async () => {
  const e = escenario()
  escribir(e.agy, '.suite.lock', JSON.stringify({ pid: 4321, comando: 'pnpm verify', secreto: 'Nabo-que-no-sale' }))
  let { datos } = await correr(e)
  assert.deepEqual(datos.repositorios[0].candados, [], 'con el nombre por defecto no se ve')
  let json
  ;({ datos, json } = await correr(e, { config: { candado: '.suite.lock' } }))
  const [c] = datos.repositorios[0].candados
  assert.equal(c.quien, 'pnpm verify · PID 4321')
  assert.equal(c.rama, 'agy/12')
  assert.match(c.desde, /UTC$/)
  assert.equal(json.includes('Nabo'), false)
  const pizarra = fs.readFileSync(`${e.raiz}/.git/consumo/PIZARRA.md`, 'utf8')
  assert.match(pizarra, /Verificando o integrando: candado de suite tomado en agy\/12 \(pnpm verify · PID 4321\)/)
})

test('la carpeta de migraciones y el candado también se leen de .claude/orquestacion.json', async () => {
  const e = escenario({ estado: { herramientas: { migraciones: 'esquema/cambios', candado: '.suite.lock' } } })
  confirmar(e.agy, 'esquema/cambios/0007_a.sql', '-- a\n')
  escribir(e.codex, '.suite.lock', 'no es json')
  const { datos } = await correr(e)
  assert.equal(datos.repositorios[0].migraciones.carpeta, 'esquema/cambios')
  assert.equal(datos.repositorios[0].migraciones.proximo_libre, '0008')
  assert.equal(datos.repositorios[0].candados[0].quien, 'tomado')
})

test('la pizarra queda en <git-common-dir>/consumo, visible desde todos los árboles, con lo que un agente necesita', async () => {
  const e = escenario({ estado: { cola: [12], fuera: { codex: 'sin cuota' } } })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  confirmar(e.agy, 'db/migrations/0002_de_agy.sql', '-- a\n')
  confirmar(e.codex, 'db/migrations/0002_de_codex.sql', '-- c\n')
  escribir(e.agy, 'a-medias.txt', 'x\n')
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'integracion/agy-12', `${e.dir}/plataforma-integra`)
  const { r } = await correr(e)
  const comun = git(e.codex, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const ruta = `${comun}/consumo/PIZARRA.md`
  assert.deepEqual(r.pizarras, [ruta])
  const md = fs.readFileSync(ruta, 'utf8')
  const sha = git(e.raiz, 'rev-parse', '--short=9', 'origin/main')
  assert.match(md, /^Foto: \d{4}-\d\d-\d\d \d\d:\d\d UTC/m)
  assert.ok(md.includes(`origin/main: ${sha}`))
  assert.match(md, /se movió aquí por última vez: \d{4}/)
  assert.match(md, />>> SIGUIENTE NÚMERO LIBRE, MEDIDO: 0003 <<</)
  assert.match(md, /Tomadas o reservadas fuera de origin\/main \(el repositorio no declara reservas\): 0002 \(#12; usada en agy\/12, codex\/34; REPETIDA/)
  assert.match(md, /árbol de integración abierto: integracion\/agy-12/)
  assert.match(md, /- agy · rama agy\/12 · #12 · 1 ficheros sin confirmar \(no significa parado\)/)
  assert.match(md, /Fuera: codex/)
  assert.match(md, /Alertas rojas \(1\):\n- El número de migración 0002/)
  assert.match(md, /git ls-remote origin refs\/heads\/main/)
  assert.match(md, /git log --all --not origin\/main --diff-filter=A --name-only --format= -- db\/migrations/)
  assert.ok(md.split('\n').length <= 30, `la pizarra tiene ${md.split('\n').length} líneas`)
  const json = JSON.parse(fs.readFileSync(`${comun}/consumo/pizarra.json`, 'utf8'))
  assert.equal(json.migraciones.siguiente_libre_medido, '0003')
  assert.equal(json.alertas_rojas.length, 1)
  // No se versiona: está dentro de .git.
  assert.equal(git(e.raiz, 'status', '--porcelain', '--', '.git'), '')
  // La segunda orden que la pizarra enseña, ejecutada, da las migraciones tomadas.
  const tomadas = execFileSync('git', ['-C', e.raiz, 'log', '--all', '--not', 'origin/main', '--diff-filter=A', '--name-only', '--format=', '--', 'db/migrations'], { env: entorno(), encoding: 'utf8' })
  assert.deepEqual(tomadas.split(/\r?\n/).filter(Boolean).sort(), ['db/migrations/0002_de_agy.sql', 'db/migrations/0002_de_codex.sql'])
})

test('una carpeta que no es un repositorio no tumba el index', async () => {
  const e = escenario()
  const suelta = carpetaTemporal('suelta')
  const r = await indice.generar({ raices: [suelta, e.raiz], salida: e.salida, sinRed: true })
  const datos = JSON.parse(fs.readFileSync(`${e.salida}/index.json`, 'utf8'))
  assert.match(datos.repositorios[0].error, /no es un repositorio/)
  assert.equal(datos.repositorios[1].arboles.length, 3)
  assert.equal(r.repositorios, 2)
})

test('cincuenta árboles se miden en menos de cinco segundos', async () => {
  const e = escenario({ sinArboles: true })
  for (let i = 0; i < 49; i++) git(e.raiz, 'worktree', 'add', '-q', '-b', `agente${i}/${100 + i}`, `${e.dir}/arbol-${i}`)
  for (let i = 0; i < 49; i += 5) escribir(`${e.dir}/arbol-${i}`, 'suelto.txt', 'x\n')
  const inicio = Date.now()
  const { datos } = await correr(e, { sinRed: true })
  const ms = Date.now() - inicio
  assert.equal(datos.repositorios[0].arboles_vistos, 50)
  assert.ok(ms < 5000, `tardó ${ms} ms`)
  console.log(`# 50 árboles: ${ms} ms`)
})

// ── 2.3.0 · Producción: otro commit no basta; tiene que haber cambiado código de lo que se despliega ──

test('producción con otro commit pero sin cambio de código: no hay cuello; con cambio de código, sí; si no está en el clon, no comparable', async () => {
  const e = escenario({ estado: { produccion: { salud: 'https://ejemplo.invalid/health' } } })
  const desplegado = git(e.raiz, 'rev-parse', 'origin/main')
  const salud = commit => async () => ({ status: 200, texto: JSON.stringify({ status: 'ok', commit }) })
  // La principal avanza sólo con documentación: un .md en la raíz, otro dentro del código, y carpetas que no se despliegan.
  confirmar(e.raiz, 'NOTAS.md', 'una nota\n')
  confirmar(e.raiz, 'docs/guia.txt', 'una guía\n')
  confirmar(e.raiz, 'gobernanza/acta.txt', 'un acta\n')
  confirmar(e.raiz, 'src/LEEME.md', 'un leeme dentro del código\n')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  let { datos, html } = await correr(e, { pedir: salud(desplegado) })
  assert.deepEqual([datos.repositorios[0].produccion.coincide, datos.repositorios[0].produccion.codigo], [false, 'igual'])
  assert.deepEqual(deTipo(datos, 'produccion'), [], 'commits distintos, mismo código: no es un cuello')
  assert.match(html, /○ al día: entre lo desplegado y la principal no cambió código/)

  // Ahora sí cambia código.
  confirmar(e.raiz, 'src/app.ts', 'export const a = 1\n')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  ;({ datos, html } = await correr(e, { pedir: salud(desplegado.slice(0, 10)) }))
  assert.equal(datos.repositorios[0].produccion.codigo, 'distinto')
  let [c] = deTipo(datos, 'produccion')
  assert.equal(c.gravedad, 'alta')
  assert.match(c.que, /^Producción corre [0-9a-f]{10} y origin\/main está en [0-9a-f]{9}: entre los dos cambió código de lo que se despliega\.$/)
  assert.equal(c.datos.codigo, 'distinto')
  assert.match(html, /■ <strong>NO<\/strong>: cambió código de lo que se despliega/)

  // Las rutas de lo que se despliega son configurables: si sólo cuenta «api/», lo de «src/» no es un cambio.
  confirmar(e.raiz, '.claude/orquestacion.json', JSON.stringify({ produccion: { salud: 'https://ejemplo.invalid/health', rutas: ['api'] } }))
  git(e.raiz, 'push', '-q', 'origin', 'main')
  ;({ datos } = await correr(e, { pedir: salud(desplegado) }))
  assert.equal(datos.repositorios[0].produccion.codigo, 'igual')
  assert.deepEqual(deTipo(datos, 'produccion'), [])

  // Un commit que este clon no tiene no se puede comparar: gravedad media, y se dice.
  ;({ datos, html } = await correr(e, { pedir: salud('abcdef1234') }))
  ;[c] = deTipo(datos, 'produccion')
  assert.equal(c.gravedad, 'media')
  assert.match(c.que, /Producción corre abcdef1234, que no está en este clon: no comparable con origin\/main/)
  assert.match(html, /▲ no comparable: abcdef1234 no está en este clon/)
  // Y con el mismo commit, nada que comparar.
  ;({ datos } = await correr(e, { pedir: salud(git(e.raiz, 'rev-parse', 'origin/main')) }))
  assert.deepEqual([datos.repositorios[0].produccion.coincide, datos.repositorios[0].produccion.codigo], [true, 'igual'])
  assert.deepEqual(deTipo(datos, 'produccion'), [])
})

// ── 2.3.0 · Un stash cuyo contenido ya está en la principal no es trabajo en riesgo ──────────────────

test('un stash cuyo contenido ya llegó a la principal no avisa; uno declarado como revisado, tampoco; los demás, sí', async () => {
  const e = escenario({ estado: { herramientas: { stash_revisados: ['guardado por si acaso'] } } })
  // agy guarda un cambio…
  fs.writeFileSync(path.join(e.agy, 'LEEME.txt'), 'plataforma\ncon una línea más\n')
  git(e.agy, 'stash')
  let { datos, html } = await correr(e)
  assert.equal(deTipo(datos, 'stash').length, 1, 'todavía no está en la principal')
  assert.equal(datos.repositorios[0].stash_sin_riesgo, 0)
  // …y ese mismo contenido llega a la principal por otro camino.
  confirmar(e.raiz, 'LEEME.txt', 'plataforma\ncon una línea más\n')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  ;({ datos, html } = await correr(e))
  assert.deepEqual(deTipo(datos, 'stash'), [])
  assert.equal(datos.repositorios[0].stash_sin_riesgo, 1)
  assert.equal(datos.repositorios[0].arboles.find(a => a.rama === 'agy/12').stash, 0)
  assert.match(html, /1 entrada del stash no avisa: su contenido ya está en origin\/main, o el repositorio las declara revisadas/)

  // Otro, con contenido que no está en ningún sitio, pero que el repositorio declara revisado por su mensaje.
  fs.writeFileSync(path.join(e.codex, 'LEEME.txt'), 'otra cosa distinta\n')
  git(e.codex, 'stash', 'push', '-q', '-m', 'guardado por si acaso')
  ;({ datos } = await correr(e))
  assert.deepEqual(deTipo(datos, 'stash'), [])
  assert.equal(datos.repositorios[0].stash_sin_riesgo, 2)
  // Y uno más, sin declarar: ése sí avisa.
  fs.writeFileSync(path.join(e.codex, 'LEEME.txt'), 'y otra más\n')
  git(e.codex, 'stash', 'push', '-q', '-m', 'sin revisar')
  ;({ datos } = await correr(e))
  assert.equal(deTipo(datos, 'stash').length, 1)
  assert.match(deTipo(datos, 'stash')[0].que, /codex\/34 tiene 1 entrada en el stash/)
})

// ── 2.3.0 · Las piezas viejas, juntas; y los datos que el control lee ───────────────────────────────

test('las piezas terminadas hace más de 2 días van en un solo aviso; la de hoy, en el suyo, con los datos para el control', async () => {
  const e = escenario({ estado: { cola: [12] } })
  escribir(e.raiz, '.claude/orquestacion.local.json', JSON.stringify({ asignaciones: { 12: { trabajador: 'agy', estado: 'vigente' } } }))
  confirmar(e.agy, 'pieza.txt', 'x\n')
  confirmar(e.codex, 'pieza.txt', 'x\n')
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'beta/56', `${e.dir}/plataforma-beta`)
  confirmar(`${e.dir}/plataforma-beta`, 'pieza.txt', 'x\n')
  // Hoy (40 minutos después): tres piezas recientes, cada una con su aviso.
  let { datos } = await correr(e, { ahora: en40(), sinRed: true })
  assert.equal(deTipo(datos, 'pieza').length, 3)
  assert.deepEqual(deTipo(datos, 'piezas-viejas'), [])
  const deAgy = deTipo(datos, 'pieza').find(c => /agy\/12/.test(c.que))
  assert.deepEqual({ ...deAgy.datos, espera_min: null }, { rama: 'agy/12', trabajador: 'agy', issue: 12, principal: false, externo: true, asignada: true, commits: 1, espera_min: null, p95_min: null, n: 0, stash: 0 })
  assert.ok(deAgy.datos.espera_min >= 39 && deAgy.datos.espera_min <= 41)

  // Tres días después: son deuda real y siguen saliendo, pero en un solo aviso que no tapa lo de hoy.
  const en3dias = Date.now() + 3 * 24 * 60 * MINUTO
  ;({ datos } = await correr(e, { ahora: en3dias, sinRed: true }))
  assert.deepEqual(deTipo(datos, 'pieza'), [])
  const [juntas] = deTipo(datos, 'piezas-viejas')
  assert.equal(juntas.gravedad, 'media')
  assert.match(juntas.que, /^3 ramas terminadas hace más de 2 días sin integrar: (agy\/12|codex\/34|beta\/56) \(1 commits, hace 3 días\), (agy\/12|codex\/34|beta\/56) \(1 commits, hace 3 días\), (agy\/12|codex\/34|beta\/56) \(1 commits, hace 3 días\)\.$/)
  assert.deepEqual(juntas.datos.piezas.map(p => p.rama).sort(), ['agy/12', 'beta/56', 'codex/34'])
  assert.equal(datos.cuellos.length, 1)
  // Una pieza de hoy junto a las viejas: sale la suya primero, y las viejas, agrupadas, después.
  git(e.raiz, 'worktree', 'add', '-q', '-b', 'gama/78', `${e.dir}/plataforma-gama`)
  const hace45 = new Date(en3dias - 45 * MINUTO).toISOString()
  execFileSync('git', ['-C', `${e.dir}/plataforma-gama`, 'commit', '-q', '--allow-empty', '-m', 'pieza de hoy', '--date', hace45], { env: { ...entorno(), GIT_COMMITTER_DATE: hace45 } })
  ;({ datos } = await correr(e, { ahora: en3dias, sinRed: true }))
  assert.deepEqual(datos.cuellos.map(c => c.tipo), ['pieza', 'piezas-viejas'])
  assert.match(datos.cuellos[0].que, /gama\/78/)
  // Una sola pieza vieja no se «agrupa»: sale como lo que es.
  const una = escenario()
  confirmar(una.agy, 'pieza.txt', 'x\n')
  ;({ datos } = await correr(una, { ahora: en3dias, sinRed: true }))
  assert.deepEqual(datos.cuellos.map(c => c.tipo), ['pieza'])
})

test('cada árbol lleva su estado en palabras y la foto dice qué issues siguen abiertas: es lo que lee el panel del mod', async () => {
  const e = escenario()
  escribir(e.agy, 'a-medias.txt', 'x\n')
  const nodo = number => ({ number, labels: { nodes: [] } })
  const g = github(e, [
    ['api.github.com/user', { status: 200, texto: '{}' }],
    ['api.github.com/graphql', { status: 200, texto: JSON.stringify({ data: { repository: { issues: { totalCount: 2, nodes: [nodo(12), nodo(34)] } }, search: { issueCount: 0 } } }) }],
  ])
  const { datos } = await correr(e, { raices: undefined, pedir: g.pedir, ahora: en40() })
  assert.deepEqual(datos.repositorios[0].arboles.map(a => [a.rama, a.forma, a.estado]), [
    ['main', '○', 'sin cambios locales y sin commits por delante'], // el .env de la credencial está en .gitignore
    ['agy/12', '■', 'tiene trabajo a medias'],
    ['codex/34', '○', 'sin cambios locales y sin commits por delante'],
  ])
  assert.deepEqual(datos.repositorios[0].github.abiertas_numeros, [12, 34])
  assert.equal(datos.repositorios[0].integracion.sin_integrar.mas_viejo_de_hoy_ms, null, 'sin commits de hoy esperando')
  // La señal de trabajo a medias de un externo lleva lo que el control necesita para no reasignarlo.
  const c = deTipo(datos, 'sin-confirmar').find(x => x.datos.rama === 'agy/12')
  assert.deepEqual([c.datos.trabajador, c.datos.externo, c.datos.sin_confirmar, c.datos.sin_moverse], ['agy', true, 1, true])
})
