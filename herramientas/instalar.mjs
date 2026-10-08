#!/usr/bin/env node
// Instala los dos disparadores del index vivo, o los quita. Node estándar; no instala nada más.
//
//   node instalar.mjs --raiz <repo> [--raiz ...] [--cada 2] [--credencial .env:VARIABLE]
//                     [--migraciones db/migrations] [--candado .suite.lock] [--salida <carpeta>]
//                     [--sin-tarea] [--sin-hooks] [--simular] [--desinstalar]
//
// --credencial, --migraciones y --candado valen para la --raiz que tienen justo antes; escritas antes de la
// primera --raiz, valen para todas.
//
// Qué hace:
//   1. Copia indice.mjs a <salida>/indice.mjs y escribe <salida>/repositorios.json.
//   2. Hooks de git (post-commit, post-merge, post-checkout, post-rewrite) en el directorio común del
//      repositorio, así valen para todos sus worktrees. Lanzan el guion en segundo plano y no bloquean a git.
//      Un hook que ya existe no se pisa: se le añade un bloque entre marcas, y desinstalar quita sólo ese bloque.
//   3. Tarea programada cada N minutos: en Windows, con schtasks y sin ventana; en Linux y macOS imprime la
//      línea de crontab y no la instala.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARCA_INICIO = '# >>> consumo-index'
export const MARCA_FIN = '# <<< consumo-index'
export const CABECERA_PROPIA = '#!/bin/sh\n# hook creado por consumo-index (se borra al desinstalar)\n'
export const HOOKS = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite']
export const TAREA = 'consumo-index'

const barras = ruta => String(ruta).replace(/\\/g, '/').replace(/\/+$/, '')
const aqui = path.dirname(fileURLToPath(import.meta.url))

export function carpetaPorDefecto() {
  return barras(path.join(os.homedir(), '.claude', 'consumo-index'))
}

/** El bloque que va dentro de un hook. Corre en segundo plano, con todo redirigido, y nunca devuelve un fallo. */
export function bloque(salida, nodo) {
  const guion = `${barras(salida)}/indice.mjs`
  return [
    MARCA_INICIO,
    '# Actualiza el index de consumo en segundo plano. Si el guion o node faltan, no pasa nada: git sigue.',
    `consumo_guion="${guion}"`,
    `consumo_node="${barras(nodo)}"`,
    '[ -x "$consumo_node" ] || consumo_node=node',
    'if [ -f "$consumo_guion" ]; then ( "$consumo_node" "$consumo_guion" </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1 || :; fi',
    MARCA_FIN,
  ].join('\n')
}

/** Un hook con el bloque puesto. Devuelve null si el hook existente no es de sh (no se toca). */
export function conBloque(contenido, elBloque) {
  if (contenido === null) return `${CABECERA_PROPIA}${elBloque}\n`
  const limpio = sinBloque(contenido) ?? contenido
  const finDePrimera = limpio.indexOf('\n')
  const primera = finDePrimera < 0 ? limpio : limpio.slice(0, finDePrimera)
  if (primera.startsWith('#!')) {
    if (!/\b(sh|bash|dash|zsh|ksh)\b/.test(primera)) return null
    // Tras la primera línea: así corre aunque el hook termine antes con «exit» o con «exec».
    if (finDePrimera < 0) return `${limpio}\n${elBloque}`
    return `${limpio.slice(0, finDePrimera + 1)}${elBloque}\n${limpio.slice(finDePrimera + 1)}`
  }
  // Sin primera línea de intérprete, git lo ejecuta con sh: el bloque va delante.
  return `${elBloque}\n${limpio}`
}

/** El hook sin el bloque, byte a byte como estaba. Devuelve null si no lo tenía. */
export function sinBloque(contenido) {
  const i = contenido.indexOf(MARCA_INICIO)
  if (i < 0) return null
  const j = contenido.indexOf(MARCA_FIN, i)
  if (j < 0) return null
  const fin = j + MARCA_FIN.length
  if (contenido[fin] === '\n') return contenido.slice(0, i) + contenido.slice(fin + 1)
  // El bloque quedó al final de un hook de una sola línea sin salto: el salto de delante era nuestro.
  return contenido.slice(0, contenido[i - 1] === '\n' ? i - 1 : i) + contenido.slice(fin)
}

function gitDe(raiz, args) {
  try {
    return execFileSync('git', ['-C', raiz, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
  } catch {
    return null
  }
}

/** Dónde viven los hooks de un repositorio: core.hooksPath si está configurado; si no, <git-common-dir>/hooks. */
export function carpetaDeHooks(raiz) {
  const comun = gitDe(raiz, ['rev-parse', '--git-common-dir'])
  if (comun === null) return null
  const dirComun = barras(path.resolve(raiz, comun))
  const configurada = gitDe(raiz, ['config', '--get', 'core.hooksPath'])
  if (configurada) return { carpeta: barras(path.resolve(raiz, configurada.replace(/^~(?=$|\/)/, os.homedir()))), porConfiguracion: true, comun: dirComun }
  return { carpeta: `${dirComun}/hooks`, porConfiguracion: false, comun: dirComun }
}

export function leerArgumentos(argv) {
  const o = { repositorios: [], cada: 2, salida: null, desinstalar: false, simular: false, sinTarea: false, sinHooks: false, ayuda: false }
  const paraTodos = {}
  const destino = () => o.repositorios[o.repositorios.length - 1] ?? paraTodos
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const valor = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`falta el valor de ${a}`)
      return v
    }
    if (a === '--raiz') o.repositorios.push({ raiz: barras(path.resolve(valor())) })
    else if (a === '--cada') {
      o.cada = Number(valor())
      if (!Number.isInteger(o.cada) || o.cada < 1 || o.cada > 1439) throw new Error('--cada es un número entero de minutos, de 1 a 1439')
    } else if (a === '--credencial') {
      const m = /^(.+):([A-Za-z_][A-Za-z0-9_]*)$/.exec(valor())
      if (!m) throw new Error('--credencial se escribe <fichero>:<VARIABLE>, por ejemplo .env:GITHUB_TOKEN')
      destino().credencial = { fichero: m[1], variable: m[2] }
    } else if (a === '--migraciones') destino().migraciones = valor()
    else if (a === '--candado') destino().candado = valor()
    else if (a === '--salida') o.salida = barras(path.resolve(valor()))
    else if (a === '--desinstalar') o.desinstalar = true
    else if (a === '--simular') o.simular = true
    else if (a === '--sin-tarea') o.sinTarea = true
    else if (a === '--sin-hooks') o.sinHooks = true
    else if (a === '--ayuda' || a === '-h' || a === '--help') o.ayuda = true
    else throw new Error(`argumento desconocido: ${a}`)
  }
  o.repositorios = o.repositorios.map(r => ({ ...paraTodos, ...r }))
  return o
}

/** La orden de schtasks que crea la tarea: cada N minutos, wscript con un .vbs que lanza node sin ventana. */
export function ordenDeTarea(salida, cada) {
  const vbs = `${barras(salida)}/lanzar.vbs`.replace(/\//g, '\\')
  return ['schtasks', '/Create', '/TN', TAREA, '/SC', 'MINUTE', '/MO', String(cada), '/TR', `wscript.exe //B //Nologo "${vbs}"`, '/F']
}

export function guionVbs(salida, nodo) {
  const comillas = t => `""${String(t).replace(/\//g, '\\')}""`
  // 0: sin ventana. False: no espera a que termine.
  return `CreateObject("WScript.Shell").Run "${comillas(nodo)} ${comillas(`${barras(salida)}/indice.mjs`)}", 0, False\r\n`
}

export function lineaDeCrontab(salida, cada, nodo) {
  return `*/${cada} * * * * "${barras(nodo)}" "${barras(salida)}/indice.mjs" >/dev/null 2>&1`
}

/** La línea que se pega en el encargo de un agente que no ejecuta el mod. */
export function lineaDeEncargo(comun) {
  return `Antes de empezar, de empujar y de numerar una migración, lee ${barras(comun)}/consumo/PIZARRA.md`
}

/**
 * Instala o desinstala. `deps`: { ejecutar(argv) → { ok, salida }, plataforma, nodo, decir(linea) }. Devuelve
 * las líneas de lo que hizo (o de lo que haría, con `simular`).
 */
export function instalar(o, deps = {}) {
  const hecho = []
  const decir = linea => {
    hecho.push(linea)
    ;(deps.decir ?? console.log)(linea)
  }
  const simular = o.simular === true
  const pre = simular ? '[simulación] ' : ''
  const salida = barras(o.salida ?? carpetaPorDefecto())
  const nodo = deps.nodo ?? process.execPath
  const plataforma = deps.plataforma ?? process.platform
  const ejecutar =
    deps.ejecutar ??
    (argv => {
      try {
        return { ok: true, salida: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
      } catch (exc) {
        return { ok: false, salida: String(exc?.stderr ?? exc?.message ?? exc).trim().split(/\r?\n/)[0] ?? '' }
      }
    })
  const rutaLista = `${salida}/repositorios.json`
  let lista = { version: 1, cada_min: o.cada, repositorios: [] }
  try {
    const leida = JSON.parse(fs.readFileSync(rutaLista, 'utf8'))
    if (Array.isArray(leida?.repositorios)) lista = { version: 1, cada_min: o.cada, repositorios: leida.repositorios.filter(r => r && typeof r.raiz === 'string') }
  } catch {
    // primera instalación
  }
  const mismo = (a, b) => barras(a).toLowerCase() === barras(b).toLowerCase()
  const escribir = (ruta, texto, modo) => {
    if (simular) return
    fs.mkdirSync(path.dirname(ruta), { recursive: true })
    fs.writeFileSync(ruta, texto, modo ? { mode: modo } : undefined)
    if (modo) {
      try {
        fs.chmodSync(ruta, modo)
      } catch {
        // En Windows el bit de ejecución no existe; git ejecuta el hook igual.
      }
    }
  }
  const borrar = ruta => {
    if (!simular) fs.rmSync(ruta, { force: true, recursive: true })
  }

  const tocarHooks = (raiz, poner) => {
    const donde = carpetaDeHooks(raiz)
    if (!donde) {
      decir(`${pre}${raiz}: no es un repositorio de git; no se toca`)
      return null
    }
    if (donde.porConfiguracion) decir(`${pre}${raiz}: core.hooksPath está configurado; se respeta y los hooks van en ${donde.carpeta} (si esa carpeta está versionada, el cambio saldrá en «git status»)`)
    if (o.sinHooks) {
      decir(`${pre}${raiz}: hooks sin tocar (--sin-hooks)`)
      return donde
    }
    for (const nombre of HOOKS) {
      const ruta = `${donde.carpeta}/${nombre}`
      let actual = null
      try {
        actual = fs.readFileSync(ruta, 'utf8')
      } catch {
        actual = null
      }
      if (poner) {
        const nuevo = conBloque(actual, bloque(salida, nodo))
        if (nuevo === null) decir(`${pre}${ruta}: ya existe y no es de sh; no se toca (ese disparador queda sin instalar)`)
        else if (nuevo === actual) decir(`${pre}${ruta}: ya tenía el bloque al día`)
        else {
          escribir(ruta, nuevo, 0o755)
          decir(`${pre}${ruta}: ${actual === null ? 'creado' : sinBloque(actual) === null ? 'ya existía; se le añade el bloque entre marcas y se conserva lo demás' : 'bloque actualizado'}`)
        }
      } else if (actual === null) decir(`${pre}${ruta}: no existe; nada que quitar`)
      else {
        const limpio = sinBloque(actual)
        if (limpio === null) decir(`${pre}${ruta}: no tiene el bloque; no se toca`)
        else if (limpio === CABECERA_PROPIA || limpio === '') {
          borrar(ruta)
          decir(`${pre}${ruta}: borrado (lo había creado este instalador)`)
        } else {
          escribir(ruta, limpio)
          decir(`${pre}${ruta}: bloque quitado; lo demás queda como estaba`)
        }
      }
    }
    return donde
  }

  if (o.desinstalar) {
    const objetivos = o.repositorios.length ? lista.repositorios.filter(r => o.repositorios.some(x => mismo(x.raiz, r.raiz))).concat(o.repositorios.filter(x => !lista.repositorios.some(r => mismo(x.raiz, r.raiz)))) : lista.repositorios
    for (const r of objetivos) {
      const donde = tocarHooks(r.raiz, false)
      if (donde && fs.existsSync(`${donde.comun}/consumo`)) {
        borrar(`${donde.comun}/consumo`)
        decir(`${pre}${donde.comun}/consumo: pizarra borrada`)
      }
    }
    const quedan = lista.repositorios.filter(r => !objetivos.some(x => mismo(x.raiz, r.raiz)))
    if (quedan.length) {
      escribir(rutaLista, `${JSON.stringify({ ...lista, repositorios: quedan }, null, 2)}\n`)
      decir(`${pre}${rutaLista}: quedan ${quedan.length} repositorios; la tarea y el guion siguen instalados para ellos`)
      return hecho
    }
    if (o.sinTarea) decir(`${pre}tarea programada sin tocar (--sin-tarea)`)
    else if (plataforma === 'win32') {
      const argv = ['schtasks', '/Delete', '/TN', TAREA, '/F']
      if (simular) decir(`${pre}se ejecutaría: ${argv.join(' ')}`)
      else {
        const r = ejecutar(argv)
        decir(r.ok ? `tarea programada «${TAREA}»: borrada` : `tarea programada «${TAREA}»: no se borró (${r.salida || 'no existía'})`)
      }
    } else decir(`${pre}crontab: si añadiste la línea de consumo-index, quítala con «crontab -e»; este instalador no toca el crontab`)
    for (const f of ['indice.mjs', 'diario.mjs', 'lanzar.vbs', 'repositorios.json', 'vistos.json', 'umbrales.json', 'diario.json', '.indice.lock', '.indice.pendiente', '.diario.lock', '.diario.intento']) {
      if (fs.existsSync(`${salida}/${f}`)) {
        borrar(`${salida}/${f}`)
        decir(`${pre}${salida}/${f}: borrado`)
      }
    }
    decir(`${pre}${salida}: el último index (index.html, index.json y las fichas de producción) se deja; bórralo a mano si no lo quieres`)
    return hecho
  }

  if (!o.repositorios.length) throw new Error('hace falta al menos una --raiz')
  for (const r of o.repositorios) if (!fs.existsSync(r.raiz)) throw new Error(`no existe ${r.raiz}`)

  const origen = `${barras(aqui)}/indice.mjs`
  escribir(`${salida}/indice.mjs`, fs.readFileSync(origen, 'utf8'))
  decir(`${pre}${salida}/indice.mjs: copiado desde ${origen}`)
  // El cálculo diario va al lado: el refresco lo lanza solo, en segundo plano, cuando el que hay es viejo.
  escribir(`${salida}/diario.mjs`, fs.readFileSync(`${barras(aqui)}/diario.mjs`, 'utf8'))
  decir(`${pre}${salida}/diario.mjs: copiado (cálculo diario; necesita credencial declarada)`)
  for (const r of o.repositorios) {
    const i = lista.repositorios.findIndex(x => mismo(x.raiz, r.raiz))
    if (i < 0) lista.repositorios.push(r)
    else lista.repositorios[i] = { ...lista.repositorios[i], ...r }
  }
  escribir(rutaLista, `${JSON.stringify(lista, null, 2)}\n`)
  decir(`${pre}${rutaLista}: ${lista.repositorios.length} ${lista.repositorios.length === 1 ? 'repositorio' : 'repositorios'}${o.repositorios.some(r => r.credencial) ? ' (de la credencial se guarda el nombre del fichero y el de la variable; el valor, nunca)' : ''}`)

  const encargos = []
  for (const r of o.repositorios) {
    const donde = tocarHooks(r.raiz, true)
    if (donde) encargos.push(lineaDeEncargo(donde.comun))
  }

  if (o.sinTarea) decir(`${pre}tarea programada sin tocar (--sin-tarea)`)
  else if (plataforma === 'win32') {
    escribir(`${salida}/lanzar.vbs`, guionVbs(salida, nodo))
    decir(`${pre}${salida}/lanzar.vbs: escrito (lanza node sin abrir ventana)`)
    const argv = ordenDeTarea(salida, o.cada)
    if (simular) decir(`${pre}se ejecutaría: ${argv.join(' ')}`)
    else {
      const r = ejecutar(argv)
      decir(r.ok ? `tarea programada «${TAREA}»: creada, cada ${o.cada} min` : `tarea programada «${TAREA}»: NO se creó (${r.salida}). La orden era: ${argv.join(' ')}`)
    }
  } else {
    decir(`${pre}crontab: este instalador no lo toca. Añade esta línea con «crontab -e»:`)
    decir(lineaDeCrontab(salida, o.cada, nodo))
  }

  decir(`${pre}El index se abre en ${salida}/index.html`)
  for (const linea of encargos) {
    decir('Línea para el encargo de un agente que no ejecuta el mod:')
    decir(linea)
  }
  return hecho
}

function esElPrincipal() {
  if (!process.argv[1]) return false
  const normal = r => {
    let real = r
    try {
      real = fs.realpathSync(r)
    } catch {
      // se compara tal cual
    }
    return process.platform === 'win32' ? real.toLowerCase() : real
  }
  return normal(path.resolve(process.argv[1])) === normal(fileURLToPath(import.meta.url))
}

if (esElPrincipal()) {
  const USO = 'Uso: node instalar.mjs --raiz <repo> [--raiz ...] [--cada 2] [--credencial .env:VARIABLE] [--migraciones <carpeta>] [--candado <fichero>] [--salida <carpeta>] [--sin-tarea] [--sin-hooks] [--simular] [--desinstalar]'
  try {
    const o = leerArgumentos(process.argv.slice(2))
    if (o.ayuda) console.log(USO)
    else instalar(o)
  } catch (exc) {
    console.error(`${exc.message}\n${USO}`)
    process.exitCode = 2
  }
}
