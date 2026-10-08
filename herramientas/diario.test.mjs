// Pruebas del cálculo diario, con datos fijos inyectados: sin red y sin reloj. Cada cifra se compara con su
// valor esperado, calculado a mano en los comentarios.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import * as diario from './diario.mjs'
import * as indice from './indice.mjs'
import { confirmar, escenario, escribir, git, limpiar } from './pruebas-comun.mjs'

after(limpiar)

/** Una hora LOCAL de junio de 2026, en ISO. El 1 de junio de 2026 es lunes. */
const L = (dia, hora = 0, minuto = 0) => new Date(2026, 5, dia, hora, minuto, 0).toISOString()
const ms = (dia, hora = 0, minuto = 0) => new Date(2026, 5, dia, hora, minuto, 0).getTime()
const AHORA = ms(24, 12) // miércoles 24 de junio, 12:00: la semana del 22 lleva 2,5 días

const issue = (number, creada, cerrada = null, razon = 'COMPLETED', labels = []) => ({ number, createdAt: creada, closedAt: cerrada, state: cerrada ? 'CLOSED' : 'OPEN', stateReason: cerrada ? razon : null, labels })

// Diez issues. Las #4 a #8 se cierran en bloque: cinco cierres con dos minutos entre uno y otro.
const ISSUES = [
  issue(1, L(1, 10), L(2, 10)), //                  construida · 1 d exacto
  issue(2, L(1, 10), L(1, 10, 30)), //              construida · 30 min (menos de una hora)
  issue(3, L(1, 10), L(3, 10), 'NOT_PLANNED'), //   descartada
  issue(4, L(1, 10), L(10, 15, 0)), //              construida · 9 d 5 h
  issue(5, L(1, 10), L(10, 15, 2)), //              hecha, sin commit
  issue(6, L(1, 10), L(10, 15, 4), 'COMPLETED', ['Épica']), // épica
  issue(7, L(8, 9), L(10, 15, 6)), //               construida · 2 d 6 h 6 min
  issue(8, L(8, 9), L(10, 15, 8)), //               hecha, sin commit
  issue(9, L(16, 10), L(23, 12)), //                construida · 7 d 2 h
  issue(10, L(23, 9)), //                           abierta
]
const COMMITS = [
  { sha: 'a', ms: ms(2, 9), issues: [1] },
  { sha: 'b', ms: ms(1, 10, 20), issues: [2] },
  { sha: 'c', ms: ms(5, 10), issues: [4] },
  { sha: 'd', ms: ms(9, 12), issues: [7] },
  { sha: 'e', ms: ms(20, 10), issues: [9] },
  { sha: 'f', ms: ms(12, 10), issues: [5] }, // nombra la #5 DESPUÉS de cerrada: no la hace «construida»
  { sha: 'g', ms: ms(3, 10), issues: [] },
]
// Cuándo llegó cada commit a la rama principal remota.
const LLEGADA = new Map([['a', ms(2, 9, 30)], ['b', ms(1, 10, 25)], ['c', ms(9, 10)], ['d', ms(9, 12, 30)], ['e', ms(22, 8)]])
const calcular = (extra = {}) => diario.calcularDiario({ issues: ISSUES, commits: COMMITS, llegada: LLEGADA, entradas: [], ahora: AHORA, ...extra })

test('universo y clases de cierre, contra la cuenta hecha a mano', () => {
  const d = calcular()
  assert.equal(d.medido, true)
  assert.deepEqual(d.universo, { issues: 10, abiertas: 1, cerradas: 9, hechas: 8, descartadas: 1, primera_alta: '2026-06-01', commits: 7, commits_que_nombran_issue: 6 })
  // Hechas sin ningún commit que las nombre antes del cierre: #5 y #8. Denominador: las 7 hechas que no son épica.
  assert.deepEqual(d.hechas_sin_commit, { n: 2, de: 7 })
})

test('la tabla semana a semana: creadas, hechas, descartadas, neto y cierres en bloque; la semana en curso, marcada', () => {
  const s = calcular().semanas
  assert.deepEqual(s.map(x => x.lunes), ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'])
  // Semana del 1: se crean 6 (#1 a #6); se cierran #1, #2 y la descartada #3. Neto 6 − 3 = +3. Quedan 3 abiertas.
  assert.deepEqual(s[0], { lunes: '2026-06-01', completa: true, dias_transcurridos: 7, altas: 6, cierres: 3, hechas: 2, descartadas: 1, construidas: 2, sin_commit: 0, epicas: 0, en_bloque: 0, fuera_de_bloque: 3, neto: 3, abiertas_al_final: 3 })
  // Semana del 8: se crean 2 (#7, #8); se cierran 5 en bloque (#4 a #8). Neto 2 − 5 = −3. Quedan 0.
  assert.deepEqual(s[1], { lunes: '2026-06-08', completa: true, dias_transcurridos: 7, altas: 2, cierres: 5, hechas: 5, descartadas: 0, construidas: 2, sin_commit: 2, epicas: 1, en_bloque: 5, fuera_de_bloque: 0, neto: -3, abiertas_al_final: 0 })
  // Semana del 15: se crea la #9 y no se cierra nada.
  assert.deepEqual([s[2].altas, s[2].cierres, s[2].neto, s[2].abiertas_al_final, s[2].completa], [1, 0, 1, 1, true])
  // Semana del 22, en curso (2,5 días): se crea la #10 y se cierra la #9.
  assert.deepEqual([s[3].altas, s[3].cierres, s[3].construidas, s[3].neto, s[3].abiertas_al_final, s[3].completa, s[3].dias_transcurridos], [1, 1, 1, 0, 1, false, 2.5])
  assert.equal(calcular().semanas_completas, 3)
})

test('cierres en bloque: cinco o más con diez minutos o menos entre uno y otro; cuatro no son bloque', () => {
  const d = calcular()
  // #4 a #8, de 15:00 a 15:08: un bloque de 5 que dura 8 minutos. Los otros 4 cierres van sueltos.
  assert.deepEqual(d.bloques, { bloques: 1, cierres_en_bloque: 5, cierres: 9, detalle: [{ dia: '2026-06-10', n: 5, duracion_min: 8 }] })
  // Sin la #8 la ráfaga es de 4: no llega a bloque.
  const cuatro = diario.calcularDiario({ issues: ISSUES.filter(i => i.number !== 8), commits: COMMITS, llegada: LLEGADA, entradas: [], ahora: AHORA })
  assert.equal(cuatro.bloques.bloques, 0)
  assert.equal(cuatro.semanas[1].en_bloque, 0)
  // Con once minutos entre la #6 y la #7 la ráfaga se parte en 3 y 2: tampoco.
  const partida = ISSUES.map(i => (i.number === 7 ? issue(7, L(8, 9), L(10, 15, 15)) : i.number === 8 ? issue(8, L(8, 9), L(10, 15, 17)) : i))
  assert.equal(diario.calcularDiario({ issues: partida, commits: COMMITS, llegada: LLEGADA, entradas: [], ahora: AHORA }).bloques.bloques, 0)
})

test('tiempo de entrega de las construidas: n, las de menos de una hora y el histograma; con n pequeño no hay mediana', () => {
  const e = calcular().entrega
  // Construidas: #1 (1 d), #2 (30 min), #4 (9 d 5 h), #7 (2 d 6 h), #9 (7 d 2 h). n = 5.
  assert.equal(e.n, 5)
  assert.equal(e.menos_de_1_hora, 1)
  assert.deepEqual(e.histograma, [{ tramo: '< 1 h', n: 1 }, { tramo: '1 h – 1 d', n: 0 }, { tramo: '1 – 3 d', n: 2 }, { tramo: '3 – 7 d', n: 0 }, { tramo: '7 – 14 d', n: 2 }, { tramo: '14 – 21 d', n: 0 }, { tramo: '> 21 d', n: 0 }])
  // n = 5 no alcanza para una mediana (hacen falta 10): no se publica ninguna cifra.
  assert.deepEqual([e.p50_dias, e.p85_dias, e.p95_dias], [null, null, null])
  assert.deepEqual([e.desde, e.hasta], ['2026-06-01', '2026-06-23'])
})

test('el n mínimo se respeta: mediana desde 10, P85 desde 20, P95 desde 40', () => {
  // k issues construidas que tardan 1, 2, …, k días exactos.
  const serie = k => {
    const issues = Array.from({ length: k }, (_, i) => issue(i + 1, new Date(2026, 0, 1, 10).toISOString(), new Date(2026, 0, 2 + i, 10).toISOString()))
    const commits = issues.map(i => ({ sha: `s${i.number}`, ms: new Date(2026, 0, 1, 11).getTime(), issues: [i.number] }))
    return diario.calcularDiario({ issues, commits, llegada: new Map(), entradas: [], ahora: new Date(2026, 2, 1).getTime() }).entrega
  }
  // 12 valores, 1…12: mediana = 6,5. Sin P85 ni P95.
  let e = serie(12)
  assert.deepEqual([e.n, e.p50_dias, e.p85_dias, e.p95_dias], [12, 6.5, null, null])
  // 20 valores, 1…20: mediana 10,5; P85 en la posición 19 × 0,85 = 16,15 → 17 + 0,15 = 17,15. Sin P95.
  e = serie(20)
  assert.equal(e.p50_dias, 10.5)
  assert.ok(Math.abs(e.p85_dias - 17.15) < 1e-9)
  assert.equal(e.p95_dias, null)
  // 40 valores, 1…40: P95 en la posición 39 × 0,95 = 37,05 → 38 + 0,05 = 38,05.
  e = serie(40)
  assert.ok(Math.abs(e.p95_dias - 38.05) < 1e-9)
  // 9: ni mediana.
  assert.equal(serie(9).p50_dias, null)
})

test('commits sin integrar al cierre de cada día', () => {
  const d = calcular()
  assert.equal(d.inventario.length, 24, 'del 1 al 24 de junio')
  const porDia = Object.fromEntries(d.inventario.map(x => [x.dia.slice(8), x.commits]))
  // «c» se escribe el 5 y llega el 9: espera al cierre de los días 5, 6, 7 y 8. «e» se escribe el 20 y llega el 22: días 20 y 21.
  // «a», «b» y «d» llegan el mismo día que se escriben: nunca esperan al cierre de un día.
  for (const dia of ['05', '06', '07', '08', '20', '21']) assert.equal(porDia[dia], 1, `día ${dia}`)
  for (const dia of ['01', '02', '03', '04', '09', '10', '19', '22', '23', '24']) assert.equal(porDia[dia], 0, `día ${dia}`)
  assert.deepEqual(d.inventario_pico, { dia: '2026-06-05', commits: 1 })
})

test('la proyección no se inventa: con menos de 8 semanas completas no hay; con 8 iguales da lo que da la resta', () => {
  assert.deepEqual(calcular().proyeccion, { medida: false, motivo: 'hay 3 semanas completas y hacen falta 8' })
  // Ocho semanas idénticas (2 altas, 5 cierres) y 20 en cola: a 4 semanas quedan 20 + 4 × (2 − 5) = 8, sin dispersión.
  const pares = Array.from({ length: 8 }, () => ({ altas: 2, cierres: 5 }))
  assert.deepEqual(diario.simularCola(pares, 20, 4, 500, diario.generador(diario.SEMILLA)), { p10: 8, p50: 8, p90: 8 })
  // La cola no baja de cero.
  assert.deepEqual(diario.simularCola(pares, 5, 4, 100, diario.generador(1)), { p10: 0, p50: 0, p90: 0 })
  // La misma semilla da la misma secuencia.
  const [a, b] = [diario.generador(diario.SEMILLA), diario.generador(diario.SEMILLA)]
  assert.deepEqual([a(), a(), a()], [b(), b(), b()])
  // Con 8 semanas completas de verdad en el tablero, sí se calcula, y dice con cuántas.
  const issues = []
  const commits = []
  let n = 0
  for (let semana = 0; semana < 9; semana++) {
    for (let k = 0; k < 3; k++) {
      n++
      issues.push(issue(n, new Date(2026, 0, 5 + semana * 7, 10).toISOString(), k < 2 ? new Date(2026, 0, 6 + semana * 7, 10).toISOString() : null))
      commits.push({ sha: `s${n}`, ms: new Date(2026, 0, 5 + semana * 7, 11).getTime(), issues: [n] })
    }
  }
  const p = diario.calcularDiario({ issues, commits, llegada: new Map(), entradas: [], ahora: new Date(2026, 2, 5, 12).getTime() }).proyeccion
  // 2026-01-05 es lunes. Hasta el jueves 5 de marzo hay 8 semanas completas; cada una, 3 altas y 2 cierres: +1 por semana.
  assert.equal(p.medida, true)
  assert.equal(p.semanas_usadas, 8)
  assert.equal(p.cola_inicial, 9)
  assert.deepEqual(p.a_4_semanas, { p10: 13, p50: 13, p90: 13 })
  assert.equal(p.estable, true)
})

test('un repositorio sin issues no da cifras', () => {
  assert.deepEqual(diario.calcularDiario({ issues: [], commits: [], llegada: new Map(), entradas: [], ahora: AHORA }), { medido: false, motivo: 'el repositorio no tiene issues' })
})

// ── Extracción y escritura, con la petición inyectada ───────────────────────────────────────────────

const SECRETO = 'ghp_SecretoDelDiario0123456789abcdefXYZ'

function githubDePrueba(paginas) {
  const pedidas = []
  const pedir = async (url, init = {}) => {
    pedidas.push({ url, autorizacion: init.headers?.authorization ?? null, cuerpo: String(init.body ?? '') })
    if (url.endsWith('/graphql') && init.body?.includes('pageInfo')) {
      const cursor = JSON.parse(init.body).variables.c
      const i = cursor === null ? 0 : Number(cursor)
      return { status: 200, texto: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: i + 1 < paginas.length, endCursor: String(i + 1) }, nodes: paginas[i].map(x => ({ number: x.number, createdAt: x.createdAt, closedAt: x.closedAt, state: x.state, stateReason: x.stateReason, labels: { nodes: x.labels.map(name => ({ name })) }, title: 'Zanahoria reconocible que nadie pidió' })) } } } }) }
    }
    if (url.endsWith('/user')) return { status: 200, texto: '{}' }
    return { status: 0, texto: '' }
  }
  return { pedidas, pedir }
}

function conCredencial(e) {
  escribir(e.raiz, '.env', `TOKEN_DE_PRUEBA=${SECRETO}\n`)
  fs.writeFileSync(`${e.salida}/repositorios.json`, JSON.stringify({ cada_min: 2, repositorios: [{ raiz: e.raiz, repo: 'acme/plataforma', credencial: { fichero: '.env', variable: 'TOKEN_DE_PRUEBA' } }] }))
}

async function callado(fn) {
  const dicho = []
  const [log, error] = [console.log, console.error]
  console.log = (...a) => dicho.push(a.join(' '))
  console.error = (...a) => dicho.push(a.join(' '))
  try {
    return { codigo: await fn(), salida: dicho.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

test('las issues se leen todas, página a página, sin pedir títulos, y la credencial sólo viaja a api.github.com', async () => {
  const g = githubDePrueba([ISSUES.slice(0, 6), ISSUES.slice(6)])
  const r = await diario.leerIssues('acme/plataforma', SECRETO, g.pedir)
  assert.equal(r.issues.length, 10)
  assert.deepEqual(r.issues[5], { number: 6, createdAt: L(1, 10), closedAt: L(10, 15, 4), state: 'CLOSED', stateReason: 'COMPLETED', labels: ['Épica'] })
  assert.equal(g.pedidas.length, 2)
  for (const p of g.pedidas) {
    assert.equal(p.url, 'https://api.github.com/graphql')
    assert.equal(p.autorizacion, `Bearer ${SECRETO}`)
    assert.doesNotMatch(p.cuerpo, /title|body/, 'la consulta no pide títulos ni cuerpos')
    assert.equal(p.cuerpo.includes(SECRETO), false)
  }
  // Aunque GitHub devolviera un título, no se guarda.
  assert.equal(JSON.stringify(r).includes('Zanahoria'), false)
  // Una credencial rechazada se dice sin repetirla.
  const rechazo = await diario.leerIssues('acme/plataforma', SECRETO, async () => ({ status: 401, texto: `Bad credentials ${SECRETO}` }))
  assert.deepEqual(rechazo, { error: 'GitHub rechazó la credencial (401)' })
})

test('la orden entera escribe diario.json sin la credencial ni títulos, y el index lo lee y dice su fecha', async () => {
  const e = escenario()
  conCredencial(e)
  // Un commit de verdad que nombra una issue, y un empuje: de ahí sale la hora de llegada.
  confirmar(e.raiz, 'arreglo.txt', 'x\n', 'arregla el formulario (#2)')
  git(e.raiz, 'push', '-q', 'origin', 'main')
  const ahora = Date.now()
  const hace = (dias, horas = 0) => new Date(ahora - dias * 86_400_000 - horas * 3_600_000).toISOString()
  const reales = [issue(1, hace(20), hace(19)), { ...issue(2, hace(3)), state: 'OPEN' }, issue(3, hace(10), hace(2), 'NOT_PLANNED')]
  const g = githubDePrueba([reales])
  const { codigo, salida } = await callado(() => indice.principal(['--diario', '--salida', e.salida], { pedir: g.pedir }))
  assert.equal(codigo, 0)
  assert.match(salida, /diario: 1 de 1 repositorio medido/)
  const texto = fs.readFileSync(`${e.salida}/diario.json`, 'utf8')
  const d = JSON.parse(texto)
  const suyo = d.repositorios[e.raiz.toLowerCase()]
  assert.equal(suyo.medido, true)
  assert.deepEqual([suyo.universo.issues, suyo.universo.abiertas, suyo.universo.cerradas, suyo.universo.descartadas], [3, 1, 2, 1])
  assert.equal(suyo.universo.commits_que_nombran_issue, 1)
  assert.equal(typeof d.calculado_ms, 'number')
  for (const prohibido of [SECRETO, 'TOKEN_DE_PRUEBA', 'Zanahoria']) assert.equal((texto + salida).includes(prohibido), false, `sale «${prohibido}»`)
  assert.equal(fs.existsSync(`${e.salida}/.diario.lock`), false)

  // El refresco lo lee, lo pinta y dice de cuándo es; ya no es NO MEDIDO.
  const r = await callado(() => indice.principal(['--salida', e.salida, '--sin-red'], {}))
  assert.equal(r.codigo, 0)
  const html = fs.readFileSync(`${e.salida}/index.html`, 'utf8')
  assert.match(html, /<h3>Altas y cierres por semana<\/h3>/)
  assert.match(html, /<th class="num">Issues creadas<\/th><th class="num">Issues hechas<\/th><th class="num">Issues descartadas<\/th><th class="num">Issues neto<\/th>/)
  assert.match(html, /calculado <span title="[^"]+">hace 0 min<\/span> \(\d{4}-\d\d-\d\d \d\d:\d\d\), una vez al día/)
  assert.match(html, /· <strong>en curso<\/strong>, \d,\d d de 7/)
  assert.match(html, /<div class="cifra"><span class="nm">NO MEDIDO<\/span> <span class="pie">n = 0, insuficiente para una mediana \(hacen falta 10\)<\/span><\/div>/)
  assert.match(html, /Proyección de la cola: <span class="nm">NO MEDIDO<\/span> <span class="pie">no se puede proyectar: hay \d semanas? completas? y hacen falta 8<\/span>/)
  assert.doesNotMatch(html, /altas y cierres por semana de plataforma<\/strong>: <span class="nm">/)
  assert.ok(html.match(/<svg /g).length >= 2)
  assert.equal(html.includes(SECRETO), false)
  // El gráfico de semanas lleva su trama (los cierres en bloque no se distinguen sólo por color) y sus cifras debajo.
  assert.match(html, /<pattern id="trama"/)
  assert.match(html, /la parte rayada, cierres en bloque \(5 o más con 10 min o menos entre uno y otro\)\. Unidad: issues\. Ventana: semanas de lunes a domingo/)
})

test('sin credencial declarada no hay cálculo diario: las secciones siguen en NO MEDIDO con su motivo', async () => {
  const e = escenario()
  fs.writeFileSync(`${e.salida}/repositorios.json`, JSON.stringify({ repositorios: [{ raiz: e.raiz }] }))
  let pedidas = 0
  const { codigo } = await callado(() => diario.principalDiario(['--salida', e.salida], { pedir: async () => (pedidas++, { status: 200, texto: '{}' }) }))
  assert.equal(codigo, 0)
  assert.equal(pedidas, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(`${e.salida}/diario.json`, 'utf8')).repositorios[e.raiz.toLowerCase()], { medido: false, motivo: 'el repositorio no declara credencial de GitHub' })
  await callado(() => indice.principal(['--salida', e.salida, '--sin-red'], {}))
  const html = fs.readFileSync(`${e.salida}/index.html`, 'utf8')
  assert.match(html, /Altas y cierres por semana, con los cierres en bloque aparte: <span class="nm">NO MEDIDO<\/span> <span class="pie">el repositorio no declara credencial de GitHub<\/span>/)
  assert.doesNotMatch(html, /<h3>Altas y cierres por semana<\/h3>/)
})

test('el refresco lanza el cálculo diario en segundo plano cuando falta o es viejo, sin esperarlo y sin repetirlo en cada foto', async () => {
  const e = escenario()
  conCredencial(e)
  const g = githubDePrueba([[]])
  const lanzadas = []
  const refrescar = (extra = []) => callado(() => indice.principal(['--salida', e.salida, ...extra], { pedir: g.pedir, lanzar: argv => lanzadas.push(argv) }))
  // Sin red no se lanza: no podría leer GitHub.
  await refrescar(['--sin-red'])
  assert.equal(lanzadas.length, 0)
  // No hay diario.json: se lanza, con la carpeta de salida, y el refresco termina sin esperarlo.
  await refrescar()
  assert.equal(lanzadas.length, 1)
  assert.match(lanzadas[0][0].replace(/\\/g, '/'), /herramientas\/diario\.mjs$/)
  assert.deepEqual(lanzadas[0].slice(1), ['--salida', e.salida])
  assert.equal(fs.existsSync(`${e.salida}/index.json`), true)
  // La foto siguiente no lo relanza: hubo un intento hace menos de media hora.
  await refrescar()
  assert.equal(lanzadas.length, 1)
  // Pasada la media hora y sin diario, sí.
  const hace40 = new Date(Date.now() - 40 * 60_000)
  fs.utimesSync(`${e.salida}/.diario.intento`, hace40, hace40)
  await refrescar()
  assert.equal(lanzadas.length, 2)
  // Con un diario.json de hace una hora, no; con uno de hace 21 horas, sí.
  fs.utimesSync(`${e.salida}/.diario.intento`, hace40, hace40)
  fs.writeFileSync(`${e.salida}/diario.json`, JSON.stringify({ calculado_ms: Date.now() - 3_600_000, repositorios: {} }))
  await refrescar()
  assert.equal(lanzadas.length, 2)
  fs.writeFileSync(`${e.salida}/diario.json`, JSON.stringify({ calculado_ms: Date.now() - 21 * 3_600_000, repositorios: {} }))
  await refrescar()
  assert.equal(lanzadas.length, 3)
  // Un repositorio sin credencial declarada nunca lo lanza.
  const sin = escenario()
  fs.writeFileSync(`${sin.salida}/repositorios.json`, JSON.stringify({ repositorios: [{ raiz: sin.raiz }] }))
  await callado(() => indice.principal(['--salida', sin.salida], { pedir: g.pedir, lanzar: argv => lanzadas.push(argv) }))
  assert.equal(lanzadas.length, 3)
})

test('con los datos fijos, la página pinta la tabla semanal, el bloque, la entrega y las hechas sin commit con sus cifras', async () => {
  const e = escenario()
  fs.writeFileSync(`${e.salida}/repositorios.json`, JSON.stringify({ repositorios: [{ raiz: e.raiz }] }))
  fs.writeFileSync(`${e.salida}/diario.json`, JSON.stringify({ calculado_ms: Date.now() - 2 * 3_600_000, repositorios: { [e.raiz.toLowerCase()]: calcular() } }))
  await callado(() => indice.principal(['--salida', e.salida, '--sin-red'], {}))
  const html = fs.readFileSync(`${e.salida}/index.html`, 'utf8')
  // Semana del 8 de junio: 2 creadas, 5 hechas, 0 descartadas, neto −3, 5 de 5 cierres en bloque, 0 abiertas al final.
  assert.match(html, /<tr><td>2026-06-08<\/td><td class="num">2<\/td><td class="num">5<\/td><td class="num">0<\/td><td class="num">−3<\/td><td class="num">5 de 5<\/td><td class="num">0<\/td><\/tr>/)
  assert.match(html, /<tr><td>2026-06-01<\/td><td class="num">6<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">\+3<\/td><td class="num">0 de 3<\/td><td class="num">3<\/td><\/tr>/)
  assert.match(html, /<td>2026-06-22 · <strong>en curso<\/strong>, 2,5 d de 7<\/td>/)
  assert.match(html, /Cierres en bloque en todo el tablero: 5 de 9 cierres, en 1 bloque \(el mayor, 5 cierres en 8,0 min el 2026-06-10\)/)
  assert.match(html, /n = 3 semanas completas, insuficiente para resumir \(hacen falta 6\)/)
  assert.match(html, /1 de 5 se cerraron a menos de una hora de crearse\./)
  assert.match(html, /<div class="cifra">2 de 7<\/div><div><strong>issues cerradas como hechas sin ningún commit que las nombre antes del cierre\.<\/strong>/)
  assert.match(html, /Cifras: máximo de 1 commit el 2026-06-05; 0 de 24 días con más de 10\./)
  assert.match(html, /calculado <span title="[^"]+">hace 2 h 0 min<\/span>/)
  assert.equal(html.match(/<svg /g).length, 4, 'hoy, semanas, histograma e inventario')
  // Con doce construidas hay mediana, con dos cifras significativas y su unidad.
  const doce = Array.from({ length: 12 }, (_, i) => issue(i + 1, new Date(2026, 0, 1, 10).toISOString(), new Date(2026, 0, 2 + i, 10).toISOString()))
  const d = diario.calcularDiario({ issues: doce, commits: doce.map(i => ({ sha: `s${i.number}`, ms: new Date(2026, 0, 1, 11).getTime(), issues: [i.number] })), llegada: new Map(), entradas: [], ahora: new Date(2026, 2, 1).getTime() })
  fs.writeFileSync(`${e.salida}/diario.json`, JSON.stringify({ calculado_ms: Date.now(), repositorios: { [e.raiz.toLowerCase()]: d } }))
  await callado(() => indice.principal(['--salida', e.salida, '--sin-red'], {}))
  const otra = fs.readFileSync(`${e.salida}/index.html`, 'utf8')
  assert.match(otra, /<div class="cifra">6,5 d<\/div><div><strong>tarda la mitad de las issues construidas, del alta al cierre\.<\/strong> P85: <span class="nm">NO MEDIDO<\/span> <span class="pie">n = 12, insuficiente para un P85 \(hacen falta 20\)<\/span>/)
  assert.doesNotMatch(otra.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' '), /\d\s*%/)
})

test('«node indice.mjs --diario», por su camino real, corre el cálculo y termina', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const e = escenario({ sinArboles: true })
  fs.writeFileSync(`${e.salida}/repositorios.json`, JSON.stringify({ repositorios: [{ raiz: e.raiz }] }))
  const guion = path.join(path.dirname(fileURLToPath(import.meta.url)), 'indice.mjs')
  const salida = execFileSync(process.execPath, [guion, '--diario', '--salida', e.salida], { encoding: 'utf8' })
  assert.match(salida, /diario: 0 de 1 repositorio medido/)
  assert.equal(JSON.parse(fs.readFileSync(`${e.salida}/diario.json`, 'utf8')).repositorios[e.raiz.toLowerCase()].motivo, 'el repositorio no declara credencial de GitHub')
})
