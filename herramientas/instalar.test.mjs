// Pruebas del instalador, contra repositorios temporales. Ninguna crea una tarea programada de verdad: la orden
// de schtasks se captura con un ejecutor de prueba, y los hooks se instalan en repositorios que crea la prueba.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as inst from './instalar.mjs'
import { carpetaTemporal, confirmar, entorno, escenario, escribir, git, limpiar } from './pruebas-comun.mjs'

after(limpiar)

const aqui = path.dirname(fileURLToPath(import.meta.url))
const callado = { decir: () => {} }

function instalar(e, extra = {}, deps = {}) {
  return inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 2, salida: e.salida, sinTarea: true, ...extra }, { ...callado, ...deps })
}
const hook = (e, nombre) => `${e.raiz}/.git/hooks/${nombre}`
const leer = ruta => fs.readFileSync(ruta, 'utf8')

async function esperar(condicion, ms = 20_000) {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    if (condicion()) return true
    await new Promise(r => setTimeout(r, 150))
  }
  return condicion()
}

test('instala: copia el guion, escribe la lista y crea los cuatro hooks en el directorio común', () => {
  const e = escenario()
  const hecho = instalar(e, { repositorios: [{ raiz: e.raiz, credencial: { fichero: '.env', variable: 'TOKEN_DE_PRUEBA' } }] })
  assert.equal(leer(`${e.salida}/indice.mjs`), leer(path.join(aqui, 'indice.mjs')))
  // El cálculo diario va al lado, para que el refresco lo pueda lanzar solo.
  assert.equal(leer(`${e.salida}/diario.mjs`), leer(path.join(aqui, 'diario.mjs')))
  const lista = JSON.parse(leer(`${e.salida}/repositorios.json`))
  assert.deepEqual(lista, { version: 1, cada_min: 2, repositorios: [{ raiz: e.raiz, credencial: { fichero: '.env', variable: 'TOKEN_DE_PRUEBA' } }] })
  for (const nombre of inst.HOOKS) {
    const texto = leer(hook(e, nombre))
    assert.ok(texto.startsWith(inst.CABECERA_PROPIA))
    assert.ok(texto.includes(inst.MARCA_INICIO) && texto.includes(inst.MARCA_FIN))
    assert.ok(texto.includes(`${e.salida}/indice.mjs`))
  }
  // Los hooks viven en el directorio común: los árboles de los agentes no tienen los suyos.
  assert.equal(fs.existsSync(`${e.raiz}/.git/worktrees/plataforma-agy/hooks`), false)
  assert.ok(hecho.some(l => l.includes('tarea programada sin tocar')))
  // La línea para el encargo de un agente externo, con la ruta absoluta de la pizarra.
  assert.ok(hecho.includes(`Antes de empezar, de empujar y de numerar una migración, lee ${e.raiz}/.git/consumo/PIZARRA.md`))
})

test('un commit en cualquier árbol actualiza el index sin que nadie lo pida, y también la pizarra', async () => {
  const e = escenario()
  instalar(e)
  assert.equal(fs.existsSync(`${e.salida}/index.json`), false)
  confirmar(e.agy, 'pieza.txt', 'x\n', 'una pieza de agy')
  assert.ok(await esperar(() => fs.existsSync(`${e.salida}/index.json`)), 'el hook no generó el index')
  assert.ok(
    await esperar(() => {
      try {
        return JSON.parse(leer(`${e.salida}/index.json`)).repositorios[0].arboles.find(a => a.rama === 'agy/12').ultimo_commit.asunto === 'una pieza de agy'
      } catch {
        return false
      }
    }),
    'el index no refleja el commit hecho en el árbol del agente',
  )
  assert.ok(await esperar(() => fs.existsSync(`${e.raiz}/.git/consumo/PIZARRA.md`)))
  assert.ok(await esperar(() => !fs.existsSync(`${e.salida}/.indice.lock`)))
  // El hook no ensucia el repositorio.
  assert.equal(git(e.raiz, 'status', '--porcelain'), '')
})

test('el hook no rompe un commit si el guion no existe, ni si node no está donde se instaló', () => {
  const e = escenario()
  instalar(e)
  fs.rmSync(`${e.salida}/indice.mjs`)
  confirmar(e.raiz, 'uno.txt', 'x\n')
  assert.equal(git(e.raiz, 'log', '-1', '--format=%s'), 'añade uno.txt')
  // Con una carpeta de salida que ya no existe y un node inventado.
  inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 2, salida: `${e.dir}/no-existe`, sinTarea: true, simular: false }, { ...callado, nodo: 'C:/no/existe/node.exe' })
  fs.rmSync(`${e.dir}/no-existe`, { recursive: true, force: true })
  confirmar(e.raiz, 'dos.txt', 'x\n')
  assert.equal(git(e.raiz, 'log', '-1', '--format=%s'), 'añade dos.txt')
  // Y con un merge, un checkout y un rebase, que son los otros tres hooks.
  git(e.raiz, 'checkout', '-q', '-b', 'otra')
  confirmar(e.raiz, 'tres.txt', 'x\n')
  git(e.raiz, 'checkout', '-q', 'main')
  git(e.raiz, 'merge', '-q', '--no-ff', '-m', 'mezcla', 'otra')
  git(e.raiz, 'rebase', '-q', 'HEAD~1')
  assert.equal(git(e.raiz, 'status', '--porcelain'), '')
})

const EXISTENTES = {
  'con sh y varias líneas': '#!/bin/sh\n# el hook del equipo\necho "del equipo" >> "$(git rev-parse --git-common-dir)/marca-del-equipo"\nexit 0\n',
  'una sola línea sin salto final': '#!/bin/sh',
  'sin primera línea de intérprete': 'echo "sin intérprete" >/dev/null\n',
  'con bash y fin de línea de Windows': '#!/usr/bin/env bash\r\necho hola >/dev/null\r\n',
  'vacío': '',
}

for (const [caso, original] of Object.entries(EXISTENTES)) {
  test(`un hook que ya existe (${caso}) conserva su contenido, y desinstalar lo deja idéntico byte a byte`, () => {
    const e = escenario()
    fs.writeFileSync(hook(e, 'post-commit'), original)
    const antes = fs.readFileSync(hook(e, 'post-commit'))
    instalar(e)
    const instalado = leer(hook(e, 'post-commit'))
    assert.ok(instalado.includes(inst.MARCA_INICIO))
    assert.equal(instalado.replace(/# >>> consumo-index[\s\S]*?# <<< consumo-index\n?/, '').replace(/\n$/, ''), original.replace(/\n$/, ''), 'lo que había sigue ahí, entero')
    // Instalar dos veces no duplica el bloque.
    instalar(e)
    assert.equal(leer(hook(e, 'post-commit')).split(inst.MARCA_INICIO).length, 2)
    inst.instalar({ repositorios: [], cada: 2, salida: e.salida, sinTarea: true, desinstalar: true }, callado)
    if (original === '') assert.equal(fs.existsSync(hook(e, 'post-commit')), false, 'un hook vacío queda borrado: no hacía nada')
    else assert.ok(fs.readFileSync(hook(e, 'post-commit')).equals(antes), 'el hook no quedó idéntico byte a byte')
    // Los que creó el instalador se borran.
    for (const nombre of ['post-merge', 'post-checkout', 'post-rewrite']) assert.equal(fs.existsSync(hook(e, nombre)), false)
  })
}

test('el hook del equipo sigue corriendo con el bloque puesto, aunque termine con «exit 0»', async () => {
  const e = escenario()
  fs.writeFileSync(hook(e, 'post-commit'), EXISTENTES['con sh y varias líneas'])
  instalar(e)
  confirmar(e.raiz, 'uno.txt', 'x\n')
  assert.equal(leer(`${e.raiz}/.git/marca-del-equipo`).trim(), 'del equipo')
  // Y el bloque, puesto tras la primera línea, corrió antes del «exit 0».
  assert.ok(await esperar(() => fs.existsSync(`${e.salida}/index.json`)), 'el bloque no corrió')
  await esperar(() => !fs.existsSync(`${e.salida}/.indice.lock`))
})

test('un hook existente que no es de sh no se toca, y se dice', () => {
  const e = escenario()
  const python = '#!/usr/bin/env python3\nprint("hola")\n'
  fs.writeFileSync(hook(e, 'post-merge'), python)
  const hecho = instalar(e)
  assert.equal(leer(hook(e, 'post-merge')), python)
  assert.ok(hecho.some(l => l.includes('post-merge') && l.includes('no es de sh')))
  assert.ok(leer(hook(e, 'post-commit')).includes(inst.MARCA_INICIO))
})

test('desinstalar deja todo como estaba: hooks, guion copiado, lista y pizarra', () => {
  const e = escenario()
  const antes = fs.readdirSync(`${e.raiz}/.git/hooks`).sort()
  instalar(e)
  escribir(`${e.raiz}/.git`, 'consumo/PIZARRA.md', 'x\n')
  fs.writeFileSync(`${e.salida}/index.html`, 'la última foto')
  const hecho = inst.instalar({ repositorios: [], cada: 2, salida: e.salida, sinTarea: true, desinstalar: true }, callado)
  assert.deepEqual(fs.readdirSync(`${e.raiz}/.git/hooks`).sort(), antes)
  assert.equal(fs.existsSync(`${e.raiz}/.git/consumo`), false)
  assert.deepEqual(fs.readdirSync(e.salida), ['index.html'], 'se va lo instalado; la última foto se deja y se dice')
  assert.ok(hecho.some(l => l.includes('el último index') && l.includes('se deja')))
})

test('desinstalar un repositorio de dos deja el otro, con su tarea y su guion', () => {
  const a = escenario({ sinArboles: true })
  const b = escenario({ sinArboles: true })
  inst.instalar({ repositorios: [{ raiz: a.raiz }], cada: 2, salida: a.salida, sinTarea: true }, callado)
  // Una segunda instalación añade; no reemplaza.
  inst.instalar({ repositorios: [{ raiz: b.raiz, migraciones: 'esquema/cambios' }], cada: 5, salida: a.salida, sinTarea: true }, callado)
  assert.deepEqual(JSON.parse(leer(`${a.salida}/repositorios.json`)), { version: 1, cada_min: 5, repositorios: [{ raiz: a.raiz }, { raiz: b.raiz, migraciones: 'esquema/cambios' }] })
  const ejecutadas = []
  inst.instalar({ repositorios: [{ raiz: a.raiz }], cada: 2, salida: a.salida, desinstalar: true }, { ...callado, plataforma: 'win32', ejecutar: argv => (ejecutadas.push(argv), { ok: true, salida: '' }) })
  assert.equal(fs.existsSync(hook(a, 'post-commit')), false)
  assert.ok(leer(hook(b, 'post-commit')).includes(inst.MARCA_INICIO))
  assert.deepEqual(JSON.parse(leer(`${a.salida}/repositorios.json`)).repositorios, [{ raiz: b.raiz, migraciones: 'esquema/cambios' }])
  assert.equal(fs.existsSync(`${a.salida}/indice.mjs`), true)
  assert.deepEqual(ejecutadas, [], 'la tarea no se borra mientras quede un repositorio')
})

test('respeta core.hooksPath si está configurado, y lo dice', () => {
  const e = escenario({ sinArboles: true })
  git(e.raiz, 'config', 'core.hooksPath', 'ganchos')
  const hecho = instalar(e)
  assert.ok(leer(`${e.raiz}/ganchos/post-commit`).includes(inst.MARCA_INICIO))
  assert.equal(fs.existsSync(hook(e, 'post-commit')), false)
  assert.ok(hecho.some(l => l.includes('core.hooksPath está configurado')))
  confirmar(e.raiz, 'uno.txt', 'x\n')
  assert.equal(git(e.raiz, 'log', '-1', '--format=%s'), 'añade uno.txt')
})

test('en Windows la tarea se crea con schtasks, nombre fijo y sin ventana; al desinstalar se borra', () => {
  const e = escenario({ sinArboles: true })
  const ejecutadas = []
  const ejecutar = argv => (ejecutadas.push(argv), { ok: true, salida: '' })
  const hecho = inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 3, salida: e.salida }, { ...callado, plataforma: 'win32', nodo: 'C:/Program Files/nodejs/node.exe', ejecutar })
  const vbs = `${e.salida}/lanzar.vbs`.replace(/\//g, '\\')
  assert.deepEqual(ejecutadas, [['schtasks', '/Create', '/TN', 'consumo-index', '/SC', 'MINUTE', '/MO', '3', '/TR', `wscript.exe //B //Nologo "${vbs}"`, '/F']])
  // El .vbs lanza node con ventana oculta (0) y sin esperar (False).
  assert.equal(leer(`${e.salida}/lanzar.vbs`), `CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""${`${e.salida}/indice.mjs`.replace(/\//g, '\\')}""", 0, False\r\n`)
  assert.ok(hecho.some(l => l.includes('creada, cada 3 min')))
  inst.instalar({ repositorios: [], cada: 2, salida: e.salida, desinstalar: true }, { ...callado, plataforma: 'win32', ejecutar })
  assert.deepEqual(ejecutadas[1], ['schtasks', '/Delete', '/TN', 'consumo-index', '/F'])
  assert.equal(fs.existsSync(`${e.salida}/lanzar.vbs`), false)
})

test('si schtasks falla, se dice y se deja la orden a la vista; lo demás queda instalado', () => {
  const e = escenario({ sinArboles: true })
  const hecho = inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 2, salida: e.salida }, { ...callado, plataforma: 'win32', ejecutar: () => ({ ok: false, salida: 'Acceso denegado' }) })
  assert.ok(hecho.some(l => l.includes('NO se creó (Acceso denegado)') && l.includes('schtasks /Create')))
  assert.ok(leer(hook(e, 'post-commit')).includes(inst.MARCA_INICIO))
})

test('en Linux y macOS imprime la línea de crontab y no instala nada', () => {
  const e = escenario({ sinArboles: true })
  const ejecutadas = []
  const hecho = inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 2, salida: e.salida }, { ...callado, plataforma: 'linux', nodo: '/usr/bin/node', ejecutar: argv => (ejecutadas.push(argv), { ok: true, salida: '' }) })
  assert.deepEqual(ejecutadas, [])
  assert.ok(hecho.includes(`*/2 * * * * "/usr/bin/node" "${e.salida}/indice.mjs" >/dev/null 2>&1`))
  assert.equal(fs.existsSync(`${e.salida}/lanzar.vbs`), false)
})

test('--simular dice lo que haría y no escribe nada', () => {
  const e = escenario({ sinArboles: true })
  const ejecutadas = []
  const hecho = inst.instalar({ repositorios: [{ raiz: e.raiz }], cada: 2, salida: e.salida, simular: true }, { ...callado, plataforma: 'win32', ejecutar: argv => (ejecutadas.push(argv), { ok: true, salida: '' }) })
  assert.deepEqual(fs.readdirSync(e.salida), [])
  assert.equal(fs.existsSync(hook(e, 'post-commit')), false)
  assert.deepEqual(ejecutadas, [])
  assert.ok(hecho.every(l => l.startsWith('[simulación]') || l.startsWith('Línea para') || l.startsWith('Antes de empezar')))
  assert.ok(hecho.some(l => l.includes('se ejecutaría: schtasks /Create /TN consumo-index')))
  // Y la desinstalación simulada tampoco quita nada.
  instalar(e)
  inst.instalar({ repositorios: [], cada: 2, salida: e.salida, desinstalar: true, simular: true }, { ...callado, plataforma: 'win32', ejecutar: argv => (ejecutadas.push(argv), { ok: true, salida: '' }) })
  assert.ok(leer(hook(e, 'post-commit')).includes(inst.MARCA_INICIO))
  assert.equal(fs.existsSync(`${e.salida}/indice.mjs`), true)
  assert.deepEqual(ejecutadas, [])
})

test('los argumentos: una credencial vale para la --raiz que tiene delante; antes de la primera, para todas', () => {
  const o = inst.leerArgumentos(['--candado', '.suite.lock', '--raiz', '/a', '--credencial', '.env:TOKEN_A', '--raiz', '/b', '--migraciones', 'esquema/cambios', '--cada', '5', '--sin-tarea'])
  assert.equal(o.cada, 5)
  assert.equal(o.sinTarea, true)
  assert.deepEqual(o.repositorios.map(r => ({ ...r, raiz: path.basename(r.raiz) })), [
    { raiz: 'a', candado: '.suite.lock', credencial: { fichero: '.env', variable: 'TOKEN_A' } },
    { raiz: 'b', candado: '.suite.lock', migraciones: 'esquema/cambios' },
  ])
  assert.throws(() => inst.leerArgumentos(['--credencial', 'sin-variable']), /<fichero>:<VARIABLE>/)
  assert.throws(() => inst.leerArgumentos(['--cada', '0']), /--cada/)
  assert.throws(() => inst.leerArgumentos(['--otra']), /desconocido/)
})

test('la orden entera, por su camino real, con --sin-tarea: instala y desinstala', () => {
  const e = escenario({ sinArboles: true })
  const correr = (...args) => execFileSync(process.execPath, [path.join(aqui, 'instalar.mjs'), ...args], { env: entorno(), encoding: 'utf8' })
  const salida = correr('--raiz', e.raiz, '--salida', e.salida, '--sin-tarea', '--credencial', '.env:TOKEN_DE_PRUEBA')
  assert.match(salida, /post-commit: creado/)
  assert.match(salida, /el valor, nunca/)
  assert.match(salida, /PIZARRA\.md/)
  assert.ok(leer(hook(e, 'post-commit')).includes(inst.MARCA_INICIO))
  const fuera = correr('--desinstalar', '--salida', e.salida, '--sin-tarea')
  assert.match(fuera, /post-commit: borrado/)
  assert.equal(fs.existsSync(hook(e, 'post-commit')), false)
  assert.equal(fs.existsSync(`${e.salida}/indice.mjs`), false)
})

test('instalar en una carpeta que no existe o sin --raiz se niega sin tocar nada', () => {
  const salida = carpetaTemporal('salida')
  assert.throws(() => inst.instalar({ repositorios: [], cada: 2, salida, sinTarea: true }, callado), /al menos una --raiz/)
  assert.throws(() => inst.instalar({ repositorios: [{ raiz: `${salida}/no-existe` }], cada: 2, salida, sinTarea: true }, callado), /no existe/)
  assert.deepEqual(fs.readdirSync(salida), [])
})
