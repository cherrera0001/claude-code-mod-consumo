#!/usr/bin/env node
// El index vivo de `consumo`, sin modelo y sin sesión abierta: Node estándar, git en sólo lectura y disco.
//
//   node indice.mjs [--raiz <repo>]... [--salida <carpeta>] [--sin-red] [--sin-pizarra]
//
// Sin --raiz lee los repositorios de <salida>/repositorios.json (la escribe instalar.mjs). Por cada uno mide
// árboles, ramas, trabajo sin confirmar, stash, remoto, migraciones, candado y control, y deja en <salida>:
//   · index.json e index.html  — privados: números de issue, ramas, trabajadores y nombres de fichero;
//                                nunca títulos de issues ni el contenido de ningún fichero.
//   · produccion-<nombre>.html y .json — públicos: sólo commit y salud.
// Y en cada repositorio, <git-common-dir>/consumo/PIZARRA.md y pizarra.json: lo mismo, en texto llano, para los
// agentes que no ejecutan el mod. Esa carpeta está dentro de .git: no se versiona y la ven todos los worktrees.
//
// Este fichero se copia tal cual a <salida>/indice.mjs: no importa nada del resto del mod.
// Ninguna orden de git que se lanza aquí escribe: ni fetch, ni gc, ni refresco del índice (--no-optional-locks).

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VERSION = '2.3.0'
export const MIN_SIN_INTEGRAR = 30
export const MIN_SIN_CONFIRMAR = 30
export const MIN_CONTROL = 30
export const MIN_DESPLIEGUE = 10
export const MIN_FOTO_VIEJA = 10
export const HORAS_EFIMERO_ACTIVO = 2
export const HORAS_RESERVA_VACIA = 2
/** Las piezas que esperan más días que éstos se cuentan juntas en un solo aviso, para que no tapen lo de hoy. */
export const DIAS_PIEZA_VIEJA = 2
/** El cálculo diario se rehace si el que hay tiene más horas que éstas. */
export const HORAS_DIARIO = 20
/** Cierres en bloque: MINIMO_BLOQUE o más cierres con HUECO_BLOQUE minutos o menos entre uno y otro. */
export const MINIMO_BLOQUE = 5
export const HUECO_BLOQUE = 10
export const LIMITE_HTTP_MS = 5000
const MIN = 60_000
const CANDADO_VIEJO_MS = 2 * MIN
const TOPE_FICHEROS = 200

// ── Utilidades ──────────────────────────────────────────────────────────────────────────────────────

export const barras = ruta => String(ruta).replace(/\\/g, '/').replace(/\/+$/, '')

/** Hora legible y sin ambigüedad de zona: «2026-05-28 20:26 UTC». */
export function instante(ms) {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export function hace(min) {
  if (min === null || min === undefined || !Number.isFinite(min)) return 'sin medir'
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  return `${Math.floor(m / 1440)} días`
}

const escapar = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function enTandas(cosas, cuantas, fn) {
  const salida = new Array(cosas.length)
  let siguiente = 0
  const obrero = async () => {
    while (siguiente < cosas.length) {
      const i = siguiente++
      salida[i] = await fn(cosas[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cuantas, cosas.length)) }, obrero))
  return salida
}

// ── git, sólo lectura ───────────────────────────────────────────────────────────────────────────────

// Un hook de git hereda GIT_DIR, GIT_INDEX_FILE y compañía del commit que lo disparó: con ellas, `git -C otro`
// seguiría mirando el repositorio del hook. Se quitan todas las que git considera locales a un repositorio.
const LOCALES_DE_GIT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_NAMESPACE',
]

function entornoDeGit() {
  const e = { ...process.env }
  for (const k of LOCALES_DE_GIT) delete e[k]
  // Nada de preguntar por una credencial ni de abrir una ventana: si el remoto la pide, queda «sin medir».
  e.GIT_TERMINAL_PROMPT = '0'
  e.GCM_INTERACTIVE = 'never'
  e.GIT_OPTIONAL_LOCKS = '0'
  return e
}

/** Las únicas órdenes de git que este guion lanza. Ninguna escribe en el repositorio. */
export const GIT_PERMITIDAS = Object.freeze({
  'worktree': a => a[1] === 'list',
  'status': () => true,
  'for-each-ref': () => true,
  'rev-parse': () => true,
  'rev-list': () => true,
  'ls-remote': () => true,
  'ls-tree': () => true,
  'stash': a => a[1] === 'list',
  'log': () => true,
  'reflog': a => a[1] === 'show',
  'config': a => a[1] === '--get',
  'remote': a => a[1] === 'get-url',
  // Entre dos commits y sólo los nombres: no mira ni toca el árbol de trabajo.
  'diff': a => (a[1] === '--name-only' || a[1] === '--quiet') && a.length >= 3 && !a[2].startsWith('-') && (a[2].includes('...') || (typeof a[3] === 'string' && !a[3].startsWith('-'))),
})

/** Para las pruebas: cada orden de git que se lanzó, sin la ruta. */
export const ordenesDeGit = []

export function git(cwd, args, ms = 15_000) {
  const permitida = GIT_PERMITIDAS[args[0]]
  if (!permitida || !permitida(args)) return Promise.reject(new Error(`orden de git no permitida: ${args.slice(0, 2).join(' ')}`))
  if (ordenesDeGit.length < 5000) ordenesDeGit.push(args.slice(0, 2).join(' '))
  return new Promise(resolver => {
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { env: entornoDeGit(), timeout: ms, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      // `codigo`: el de salida del proceso (0 si fue bien; null si no llegó a terminar).
      resolver({ ok: !error, out: String(stdout ?? ''), codigo: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
    })
  })
}

// ── Lo portado de hooks/indice.ts (una prueba compara las dos salidas sobre el mismo estado) ────────

export const SIN_PASO = 'no hay paso'
export const NOMBRE = { claude: 'Esta sesión', agy: 'Agy', codex: 'Codex' }

export function saludDe(respuesta) {
  let d
  try {
    const leido = JSON.parse(respuesta)
    if (!leido || typeof leido !== 'object') return { commit: null, bien: false }
    d = leido
  } catch {
    return { commit: null, bien: false }
  }
  const commit = typeof d.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(d.commit) ? d.commit.toLowerCase() : null
  const dicho = [d.status, d.estado].find(x => typeof x === 'string')
  return { commit, bien: d.ok === true || (dicho ?? '').trim().toLowerCase() === 'ok' }
}

const CABEZA = titulo =>
  `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapar(titulo)}</title>\n<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}section{border:1px solid;padding:0 1rem;margin:1rem 0}dt{font-weight:bold}dd{margin:0 0 .5rem 0}</style>\n</head>\n<body>\n`

/**
 * La ficha de producción, pública: commit publicado, salud y hora. Recibe SÓLO { commit, bien, cuando }: no
 * recibe el estado de orquestación ni lo medido en git, así que no puede filtrar backlog ni por descuido.
 */
export function fichaDeProduccion(s) {
  const foto = instante(s.cuando)
  const commit = s.commit && /^[0-9a-f]{7,40}$/.test(s.commit) ? s.commit : null
  const salud = s.bien ? 'bien' : 'con problemas o sin respuesta'
  const html =
    CABEZA('Producción') +
    [
      '<h1>Producción</h1>',
      '<dl>',
      `<dt>Commit publicado</dt><dd>${commit ? `<code>${commit}</code>` : 'no publicado'}</dd>`,
      `<dt>Salud</dt><dd>${salud}</dd>`,
      `<dt>Foto</dt><dd>${foto}</dd>`,
      '</dl>',
      '</body>',
      '</html>',
      '',
    ].join('\n')
  return { html, json: `${JSON.stringify({ commit, bien: s.bien === true, foto }, null, 2)}\n` }
}

export function nombreDeArchivo(nombre) {
  return (
    String(nombre)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'proyecto'
  )
}

/** Sólo http(s). */
export function urlDeSalud(estado) {
  const url = estado?.produccion?.salud
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) ? url : null
}

/**
 * Quién tiene cada issue y su paso sin hacer. Del estado sólo sale el número, el trabajador, si la asignación
 * está vigente, el primer paso sin `hecho` y si espera al dueño (sí o no, sin el motivo). Ni títulos, ni cola,
 * ni clasificación, ni encargos.
 */
export function controlDe(estado) {
  const asignaciones = []
  for (const [clave, a] of Object.entries(estado?.asignaciones ?? {})) {
    const numero = Number(clave)
    if (!Number.isInteger(numero) || !a || typeof a !== 'object') continue
    const d = estado?.declarado?.[clave]
    const siguiente = (Array.isArray(d?.pasos) ? d.pasos : []).find(p => p && !p.hecho)
    const trabajador = String(a.trabajador ?? '').toLowerCase().slice(0, 40)
    asignaciones.push({
      issue: numero,
      trabajador,
      quien: NOMBRE[trabajador] ?? trabajador,
      estado: a.estado === 'por retomar' ? 'por retomar' : 'vigente',
      paso: siguiente?.paso ? String(siguiente.paso) : SIN_PASO,
      espera: Boolean(d?.espera),
    })
  }
  asignaciones.sort((a, b) => a.issue - b.issue)
  return { asignaciones, fuera: Object.keys(estado?.fuera ?? {}).map(k => k.toLowerCase().slice(0, 40)).sort() }
}

// ── Lectura del repositorio ─────────────────────────────────────────────────────────────────────────

const PREFIJOS_QUE_NO_SON_AGENTES = new Set(['fix', 'feat', 'feature', 'chore', 'docs', 'hotfix', 'bugfix', 'test', 'tests', 'refactor', 'release', 'ci', 'build', 'perf', 'style', 'revert', 'dependabot', 'renovate'])

/** Convención de rama <agente>/<número>. El árbol principal es «sesión principal». */
export function trabajadorDe(rama, principal) {
  if (principal) return { trabajador: 'sesión principal', clave: 'claude', issue: null }
  const m = /^([A-Za-z][\w.-]*)\/(\d+)$/.exec(rama ?? '')
  if (!m || PREFIJOS_QUE_NO_SON_AGENTES.has(m[1].toLowerCase())) return { trabajador: null, clave: null, issue: null }
  return { trabajador: m[1].toLowerCase(), clave: m[1].toLowerCase(), issue: Number(m[2]) }
}

export const esEfimero = ruta => barras(ruta).includes('.claude/worktrees/')

function leerArboles(porcelana) {
  const arboles = []
  let a = null
  for (const linea of porcelana.split(/\r?\n/)) {
    if (linea.startsWith('worktree ')) {
      a = { ruta: barras(linea.slice(9)), rama: null, cabeza: null, desnudo: false, falta: false }
      arboles.push(a)
    } else if (!a) continue
    else if (linea.startsWith('HEAD ')) a.cabeza = linea.slice(5).trim()
    else if (linea.startsWith('branch ')) a.rama = linea.slice(7).trim().replace(/^refs\/heads\//, '')
    else if (linea === 'bare') a.desnudo = true
    else if (linea.startsWith('prunable')) a.falta = true
  }
  return arboles.filter(x => !x.desnudo)
}

/** `git status --porcelain=v2 --branch -z`: las rutas con cambios, sin leer ningún fichero. */
export function rutasDeEstado(salida) {
  const rutas = []
  const partes = salida.split('\0')
  for (let i = 0; i < partes.length; i++) {
    const r = partes[i]
    if (!r || r.startsWith('# ')) continue
    if (r.startsWith('? ')) rutas.push(r.slice(2))
    else if (r.startsWith('1 ')) rutas.push(r.split(' ').slice(8).join(' '))
    else if (r.startsWith('2 ')) {
      rutas.push(r.split(' ').slice(9).join(' '))
      i++ // la ruta de origen del renombrado va en el registro siguiente
    } else if (r.startsWith('u ')) rutas.push(r.split(' ').slice(10).join(' '))
  }
  return rutas
}

async function medirArbol(a, i, ctx) {
  const principal = i === 0
  const quien = trabajadorDe(a.rama, principal)
  const ref = a.rama ? ctx.ramas.get(a.rama) : null
  const arbol = {
    ruta: a.ruta,
    rama: a.rama,
    cabeza: (a.cabeza ?? '').slice(0, 9) || null,
    principal,
    efimero: esEfimero(a.ruta),
    trabajador: quien.trabajador,
    issue: quien.issue,
    ultimo_commit: ref ? { cuando: instante(ref.cuando), ms: ref.cuando, hace_min: (ctx.ahora - ref.cuando) / MIN, asunto: ref.asunto } : null,
    delante: ref ? ref.delante : null,
    detras: ref ? ref.detras : null,
    sin_confirmar: null,
    mas_reciente: null,
    stash: a.rama ? (ctx.stash.get(a.rama)?.length ?? 0) : 0,
    candado: null,
    actividad_hace_min: null,
  }
  let ultimoMs = ref ? ref.cuando : 0
  if (a.falta || !fs.existsSync(a.ruta)) {
    arbol.falta = true
    return { arbol, clave: quien.clave, ultimoCommitMs: ref ? ref.cuando : null }
  }
  if (!ref) {
    // HEAD suelto: no hay rama que venga de for-each-ref, se mide a mano.
    const [l, c] = await Promise.all([
      git(a.ruta, ['log', '-1', '--format=%ct%x00%s']),
      ctx.principalRef ? git(a.ruta, ['rev-list', '--left-right', '--count', `${ctx.principalRef}...HEAD`]) : Promise.resolve({ ok: false, out: '' }),
    ])
    const [ct, asunto] = l.out.trim().split('\0')
    if (l.ok && Number(ct)) {
      ultimoMs = Number(ct) * 1000
      arbol.ultimo_commit = { cuando: instante(ultimoMs), ms: ultimoMs, hace_min: (ctx.ahora - ultimoMs) / MIN, asunto: (asunto ?? '').slice(0, 120) }
    }
    const m = /^(\d+)\s+(\d+)/.exec(c.out.trim())
    if (c.ok && m) {
      arbol.detras = Number(m[1])
      arbol.delante = Number(m[2])
    }
  }
  const commitMs = ultimoMs || null
  let rutas = []
  const s = await git(a.ruta, ['status', '--porcelain=v2', '--branch', '-z'], 30_000)
  if (s.ok) {
    rutas = rutasDeEstado(s.out)
    arbol.sin_confirmar = rutas.length
    let reciente = null
    for (const r of rutas.slice(0, TOPE_FICHEROS)) {
      try {
        const m = fs.statSync(path.join(a.ruta, r)).mtimeMs
        if (!reciente || m > reciente.ms) reciente = { ms: m, fichero: r }
      } catch {
        // Un fichero borrado no tiene hora: no cuenta.
      }
    }
    if (reciente) {
      arbol.mas_reciente = { fichero: reciente.fichero, cuando: instante(reciente.ms), ms: Math.round(reciente.ms), hace_min: (ctx.ahora - reciente.ms) / MIN }
      ultimoMs = Math.max(ultimoMs, reciente.ms)
    }
  }
  arbol.candado = leerCandado(path.join(a.ruta, ctx.cfg.candado), ctx.ahora)
  if (ultimoMs) arbol.actividad_hace_min = (ctx.ahora - ultimoMs) / MIN
  return { arbol, clave: quien.clave, ultimoCommitMs: commitMs, rutas }
}

/** Del candado sale quién lo tiene (PID y orden, si es JSON de una línea) y desde cuándo (la hora del fichero). */
export function leerCandado(ruta, ahora) {
  let st
  try {
    st = fs.statSync(ruta)
  } catch {
    return null
  }
  const candado = { quien: 'tomado', desde: instante(st.mtimeMs), hace_min: (ahora - st.mtimeMs) / MIN }
  try {
    const d = JSON.parse(fs.readFileSync(ruta, 'utf8').slice(0, 4000))
    const orden = [d.comando, d.orden, d.etiqueta, d.suite, d.command].find(x => typeof x === 'string' && x.trim())
    const pid = Number.isInteger(d.pid) ? `PID ${d.pid}` : ''
    candado.quien = [orden ? orden.trim().replace(/\s+/g, ' ').slice(0, 60) : '', pid].filter(Boolean).join(' · ') || 'tomado'
  } catch {
    // No es JSON: se dice que está tomado y desde cuándo, sin copiar su contenido.
  }
  return candado
}

function leerJson(ruta) {
  try {
    const d = JSON.parse(fs.readFileSync(ruta, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null
  } catch {
    return null
  }
}

/** La variable de un fichero tipo .env. Devuelve el valor o ''; quien llama no lo imprime ni lo guarda. */
export function leerCredencial(raiz, credencial) {
  if (!credencial || typeof credencial.fichero !== 'string' || typeof credencial.variable !== 'string') return ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credencial.variable)) return ''
  let texto
  try {
    texto = fs.readFileSync(path.resolve(raiz, credencial.fichero), 'utf8')
  } catch {
    return ''
  }
  for (const linea of texto.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linea)
    if (!m || m[1] !== credencial.variable) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    return v
  }
  return ''
}

/** Una petición con tiempo límite. Nunca lanza, y de un fallo no devuelve texto: sólo que no hubo respuesta. */
export async function pedirDeVerdad(url, init = {}) {
  try {
    const r = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, redirect: init.redirect ?? 'follow', signal: AbortSignal.timeout(LIMITE_HTTP_MS) })
    return { status: r.status, texto: await r.text() }
  } catch {
    return { status: 0, texto: '' }
  }
}

function repoDeGitHub(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url).trim())
  return m ? `${m[1]}/${m[2]}` : null
}

const prefijoDe = fichero => /^(\d+)/.exec(path.posix.basename(fichero))?.[1] ?? null

function listaDeArbol(salida) {
  // «<modo> blob <sha>\t<ruta>»
  const ficheros = new Map()
  for (const linea of salida.split(/\r?\n/)) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(linea)
    if (m) ficheros.set(path.posix.basename(m[2]), m[1])
  }
  return ficheros
}

/** Los ficheros de la carpeta de migraciones que un árbol tiene sin confirmar (nuevos o modificados). */
export function migracionesSinConfirmar(arbol, rutas, carpeta) {
  const nombres = new Set()
  for (const ruta of rutas) {
    const r = barras(ruta)
    if (ruta.endsWith('/') && (carpeta === r || carpeta.startsWith(`${r}/`))) {
      // git resume una carpeta entera sin seguimiento en una línea: lo que hay dentro se lee del disco.
      try {
        for (const f of fs.readdirSync(path.join(arbol, carpeta), { withFileTypes: true })) if (f.isFile()) nombres.add(f.name)
      } catch {
        // la carpeta no está en este árbol
      }
    } else if (path.posix.dirname(r) === carpeta) nombres.add(path.posix.basename(r))
  }
  return [...nombres].sort()
}

/** La tabla de reservas de .claude/orquestacion.json. Las claves que empiezan por «_» y `siguiente_libre` no son reservas. */
export function reservasDe(declarado) {
  const tabla = declarado?.migraciones
  if (!tabla || typeof tabla !== 'object' || Array.isArray(tabla)) return null
  const reservas = new Map()
  for (const [clave, v] of Object.entries(tabla)) {
    if (clave.startsWith('_') || clave === 'siguiente_libre' || !/^\d+$/.test(clave) || !v || typeof v !== 'object') continue
    reservas.set(Number(clave), {
      prefijo: clave,
      issue: Number.isInteger(v.issue) ? v.issue : null,
      quien: typeof v.quien === 'string' ? v.quien.trim().replace(/\s+/g, ' ').slice(0, 40) : null,
      soloReservada: /^\s*reservada/i.test(String(v.estado ?? '')),
    })
  }
  const dicho = tabla.siguiente_libre
  const siguiente = (typeof dicho === 'string' || typeof dicho === 'number') && /^\d+$/.test(String(dicho)) ? String(dicho) : null
  return { reservas, siguiente }
}

/**
 * El uso real de los números de migración: en la rama principal, en cada rama con commits por delante y en los
 * ficheros sin confirmar de cada árbol (que es donde un número aparece primero), frente a la tabla de reservas
 * si el repositorio la declara. `arboles`: [{ arbol, rutas }]. `issuesPrincipal`: las issues de la sesión principal.
 */
async function medirMigraciones(raiz, cfg, principalRef, ramas, arboles, declarado, issuesPrincipal) {
  const carpeta = barras(cfg.migraciones)
  const base = principalRef ? await git(raiz, ['ls-tree', principalRef, `${carpeta}/`]) : { ok: false, out: '' }
  const enPrincipal = listaDeArbol(base.ok ? base.out : '')
  const numerosPrincipal = new Map()
  for (const f of enPrincipal.keys()) {
    const p = prefijoDe(f)
    if (p !== null) numerosPrincipal.set(Number(p), f)
  }
  const ramaPrincipalLocal = arboles[0]?.arbol.rama ?? null
  const issuesDe = (sitio, esArbolPrincipal) => {
    if (esArbolPrincipal || (ramaPrincipalLocal !== null && sitio === ramaPrincipalLocal)) return issuesPrincipal.size ? issuesPrincipal : null
    const n = trabajadorDe(sitio, false).issue
    return n === null ? null : new Set([n])
  }
  // Los usos fuera de la rama principal: { numero, prefijo, sitio, fichero, sha, confirmado, issues }.
  const usos = []
  const delante = [...ramas.entries()].filter(([, r]) => (r.delante ?? 0) > 0)
  const porRama = await enTandas(delante, 12, async ([rama]) => ({ rama, lista: listaDeArbol((await git(raiz, ['ls-tree', `refs/heads/${rama}`, `${carpeta}/`])).out) }))
  for (const { rama, lista } of porRama) {
    for (const [f, sha] of lista) {
      const p = prefijoDe(f)
      // Lo que la rama trae y la principal no tiene por nombre. El mismo nombre con otro contenido es una
      // edición de una migración que ya existe, no un número nuevo.
      if (p !== null && !enPrincipal.has(f)) usos.push({ numero: Number(p), prefijo: p, sitio: rama, fichero: f, sha, confirmado: true, issues: issuesDe(rama, false) })
    }
  }
  for (const { arbol, rutas } of arboles) {
    if (arbol.falta || !rutas?.length) continue
    const sitio = arbol.rama ?? arbol.ruta
    for (const f of migracionesSinConfirmar(arbol.ruta, rutas, carpeta)) {
      const p = prefijoDe(f)
      if (p === null || enPrincipal.has(f) || usos.some(u => u.sitio === sitio && u.fichero === f)) continue
      usos.push({ numero: Number(p), prefijo: p, sitio, fichero: f, sha: null, confirmado: false, issues: issuesDe(sitio, arbol.principal) })
    }
  }
  const existe = enPrincipal.size > 0 || usos.length > 0 || fs.existsSync(path.join(raiz, carpeta))
  const porNumero = new Map()
  for (const u of usos) {
    if (!porNumero.has(u.numero)) porNumero.set(u.numero, [])
    porNumero.get(u.numero).push(u)
  }

  // (b) El mismo número con ficheros distintos en dos sitios. Dos sitios con el fichero del mismo nombre son la
  // misma migración aunque el contenido difiera: una rama sale de la otra y la siguió editando.
  const repetidos = []
  for (const [numero, lista] of [...porNumero.entries()].sort((a, b) => a[0] - b[0])) {
    const distintos = []
    for (const u of lista) if (!distintos.some(d => d.fichero === u.fichero)) distintos.push(u)
    const entre = numerosPrincipal.has(numero) ? [{ rama: cfg.principal, fichero: numerosPrincipal.get(numero) }] : []
    if (entre.length || distintos.length > 1) {
      for (const u of distintos) entre.push({ rama: u.sitio, fichero: u.fichero })
      repetidos.push({ numero: lista[0].prefijo, entre })
    }
  }

  const tabla = reservasDe(declarado)
  const alertas = []
  const sinFichero = []
  const ajenas = new Set()
  const todos = [...numerosPrincipal.keys(), ...porNumero.keys(), ...(tabla ? tabla.reservas.keys() : [])]
  const ancho = Math.max(1, ...[...enPrincipal.keys()].map(f => prefijoDe(f)?.length ?? 0), ...usos.map(u => u.prefijo.length), ...(tabla ? [...tabla.reservas.values()].map(r => r.prefijo.length) : []))
  const escrito = n => String(n).padStart(ancho, '0')
  const proximo = (todos.length ? Math.max(...todos) : 0) + 1
  if (tabla) {
    // (a) Un número en uso cuya reserva no existe o es de otra issue.
    const vistos = new Set()
    for (const u of usos) {
      if (vistos.has(`${u.numero}\0${u.sitio}`)) continue
      vistos.add(`${u.numero}\0${u.sitio}`)
      const reserva = tabla.reservas.get(u.numero)
      const donde = `${u.sitio}${u.confirmado ? '' : ' (fichero sin confirmar)'}`
      if (!reserva) alertas.push({ tipo: 'reserva', numero: u.prefijo, donde, sitio: u.sitio, reserva_de: null, clave: `reserva:${u.numero}:${u.sitio}`, que: `La migración ${u.prefijo} está en uso en ${donde} y no está reservada para ella.` })
      else if (reserva.issue !== null && u.issues && !u.issues.has(reserva.issue)) {
        ajenas.add(u.numero)
        alertas.push({ tipo: 'reserva', numero: u.prefijo, donde, sitio: u.sitio, reserva_de: reserva.issue, clave: `reserva:${u.numero}:${u.sitio}`, que: `La migración ${u.prefijo} está en uso en ${donde} y su reserva es de la #${reserva.issue}.` })
      }
    }
    // (c) El siguiente libre declarado ya no es libre.
    if (tabla.siguiente !== null && Number(tabla.siguiente) < proximo) {
      alertas.push({ tipo: 'siguiente-libre', clave: `siguiente:${tabla.siguiente}`, que: `El siguiente_libre declarado (${tabla.siguiente}) no es libre: hay números usados o reservados hasta ${escrito(proximo - 1)}. El medido es ${escrito(proximo)}.` })
    }
    for (const [numero, reserva] of tabla.reservas) if (reserva.soloReservada && !numerosPrincipal.has(numero) && !porNumero.has(numero)) sinFichero.push(reserva.prefijo)
  }

  // Lo tomado y lo reservado fuera de la rama principal, con el estado MEDIDO (no el que alguien escribió).
  const numerosDeTabla = [...new Set([...porNumero.keys(), ...(tabla ? [...tabla.reservas.keys()].filter(n => !numerosPrincipal.has(n) || porNumero.has(n)) : [])])].sort((a, b) => a - b)
  const filas = numerosDeTabla.map(numero => {
    const lista = porNumero.get(numero) ?? []
    const reserva = tabla?.reservas.get(numero)
    const deSitio = [...new Set(lista.flatMap(u => (u.issues && u.issues.size === 1 ? [...u.issues] : [])))][0] ?? null
    const usada = [...new Set(lista.map(u => `${u.sitio}${u.confirmado ? '' : ' (sin confirmar)'}`))]
    const prefijo = reserva?.prefijo ?? lista[0]?.prefijo ?? escrito(numero)
    let estado
    if (repetidos.some(r => Number(r.numero) === numero)) estado = 'REPETIDA: el mismo número con ficheros distintos'
    else if (!lista.length) estado = 'reservada, sin fichero en ningún sitio'
    else if (!tabla) estado = 'en uso'
    else if (!reserva) estado = 'EN USO SIN RESERVA'
    else if (ajenas.has(numero)) estado = 'EN USO POR OTRA ISSUE que la de la reserva'
    else estado = 'en uso, con su reserva'
    return { numero: prefijo, issue: reserva?.issue ?? deSitio, reservada: Boolean(reserva), reservada_para: reserva ? reserva.quien ?? (reserva.issue === null ? 'sin nombre' : `#${reserva.issue}`) : null, usada_en: usada, estado }
  })
  const tomados = usos.map(u => ({ numero: u.prefijo, rama: u.sitio, fichero: u.fichero, confirmado: u.confirmado })).sort((a, b) => Number(a.numero) - Number(b.numero) || a.rama.localeCompare(b.rama))
  return {
    carpeta,
    existe,
    ultimo_en_principal: numerosPrincipal.size ? escrito(Math.max(...numerosPrincipal.keys())) : null,
    tomados,
    repetidos,
    reservas: { declaradas: Boolean(tabla), tabla: filas, siguiente_libre_declarado: tabla?.siguiente ?? null, sin_fichero: sinFichero },
    alertas,
    proximo_libre: escrito(proximo),
    difiere_del_declarado: tabla?.siguiente != null && Number(tabla.siguiente) !== proximo,
  }
}

// ── Dónde espera el trabajo: empujes, huecos, commits sin integrar, incidentes ─────────────────────

const p2 = n => String(n).padStart(2, '0')
/** El día, en la zona local de la máquina: «2026-05-28». */
export const diaLocal = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
const inicioDelDia = ms => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function cuantil(valores, q) {
  const xs = [...valores].sort((a, b) => a - b)
  if (!xs.length) return null
  const pos = (xs.length - 1) * q
  const bajo = Math.floor(pos)
  return xs[bajo] + (xs[Math.min(bajo + 1, xs.length - 1)] - xs[bajo]) * (pos - bajo)
}

/** Un P95 con menos de 40 observaciones no se publica: no hay dos por encima del percentil. */
export const N_MINIMO_P95 = 40

/**
 * El umbral de los huecos entre empujes: el P95 de los minutos entre empujes consecutivos del mismo día, del
 * reflog de la rama principal remota. Se calcula una vez al día y se guarda; el refresco sólo compara, para que
 * un aviso no cambie de criterio entre dos fotos. `entradas`: [{ ms, empuje }].
 */
export function umbralDeHuecos(entradas, ahora) {
  const empujes = entradas.filter(e => e.empuje).map(e => e.ms).sort((a, b) => a - b)
  const huecos = []
  for (let i = 1; i < empujes.length; i++) if (diaLocal(empujes[i]) === diaLocal(empujes[i - 1])) huecos.push((empujes[i] - empujes[i - 1]) / MIN)
  const p95 = huecos.length >= N_MINIMO_P95 ? cuantil(huecos, 0.95) : null
  return { calculado: diaLocal(ahora), n: huecos.length, dias: new Set(empujes.map(diaLocal)).size, desde: empujes.length ? diaLocal(empujes[0]) : null, p95_min: p95 === null ? null : Math.round(p95) }
}

/** El registro de incidentes de coordinación: una línea por incidente, campos separados por tabulador. La frase libre del final no se lee. */
export function incidentesDe(texto, ahora) {
  const hoy = diaLocal(ahora)
  const dias = new Set()
  const deHoy = []
  let cierreHoy = false
  for (const linea of texto.split(/\r?\n/)) {
    if (!linea.trim() || linea.startsWith('#')) continue
    const [fecha, , causa, coste, deteccion, recurso] = linea.split('\t')
    if (!/^\d{4}-\d\d-\d\d$/.test(fecha ?? '') || !causa) continue
    dias.add(fecha)
    if (fecha !== hoy) continue
    if (causa === 'cierre') cierreHoy = true
    else if (/^[a-z_-]{1,20}$/.test(causa)) deHoy.push({ causa, coste: /^\d+$/.test(coste ?? '') ? Number(coste) : null, auto: deteccion === 'auto', recurso: /^[a-z_-]{1,20}$/.test(recurso ?? '') ? recurso : null })
  }
  const porCausa = new Map()
  for (const i of deHoy) porCausa.set(i.causa, (porCausa.get(i.causa) ?? 0) + 1)
  const conCoste = deHoy.filter(i => i.coste !== null)
  return {
    hoy: deHoy.length,
    en_causa_repetida: deHoy.filter(i => porCausa.get(i.causa) > 1).length,
    por_causa: [...porCausa.entries()].map(([causa, n]) => ({ causa, n })).sort((a, b) => b.n - a.n || a.causa.localeCompare(b.causa)),
    coste_min: conCoste.reduce((s, i) => s + i.coste, 0),
    con_coste: conCoste.length,
    detectados_solos: deHoy.filter(i => i.auto).length,
    dias_con_registro: dias.size,
    dia_cerrado: cierreHoy,
  }
}

/**
 * Lo que espera sin llegar a la rama principal remota, sólo con git: los commits escritos y sin integrar (total,
 * de hoy, por rama y el más viejo), los empujes de hoy y el hueco desde el último, frente al umbral guardado.
 */
async function medirIntegracion(raiz, principalRef, reflog, ramas, ahora, umbrales) {
  const entradas = []
  for (const linea of reflog.ok ? reflog.out.split(/\r?\n/) : []) {
    const [sha, ct, asunto] = linea.split('\0')
    if (Number(ct)) entradas.push({ sha, ms: Number(ct) * 1000, empuje: (asunto ?? '').startsWith('update by push') })
  }
  const hoy0 = inicioDelDia(ahora)
  const clave = raiz.toLowerCase()
  let umbral = umbrales?.[clave]
  if (!umbral || umbral.calculado !== diaLocal(ahora) || typeof umbral.n !== 'number') {
    umbral = umbralDeHuecos(entradas, ahora)
    if (umbrales) umbrales[clave] = umbral
  }

  // Todos los commits escritos que no están en la rama principal remota, una vez cada uno.
  // `ramas` trae sólo las que no son antiguas: una rama muerta hace un mes no es trabajo esperando.
  const delante = [...ramas.entries()].filter(([, r]) => (r.delante ?? 0) > 0)
  const fuera = delante.length ? await git(raiz, ['rev-list', ...delante.map(([rama]) => `refs/heads/${rama}`), '--not', principalRef, '--format=%ct', '--no-commit-header'], 20_000) : { ok: true, out: '' }
  const horas = fuera.ok ? fuera.out.split(/\r?\n/).map(l => Number(l) * 1000).filter(Boolean) : null
  const porRama = await enTandas(delante, 12, async ([rama, r]) => {
    const l = await git(raiz, ['rev-list', `${principalRef}..refs/heads/${rama}`, '--format=%ct', '--no-commit-header'])
    const hs = l.out.split(/\r?\n/).map(x => Number(x) * 1000).filter(Boolean)
    return { rama, commits: r.delante, de_hoy: hs.filter(h => h >= inicioDelDia(ahora)).length, mas_viejo_ms: hs.length ? Math.min(...hs) : null, ultimo_ms: r.cuando }
  })
  porRama.sort((a, b) => b.ultimo_ms - a.ultimo_ms)
  const esperandoHoy = horas ? horas.filter(h => h >= hoy0) : []

  // Hoy: cuándo llegó cada commit. Cada entrada del reflog de hoy trae los commits que no estaban en la anterior.
  const cronologico = [...entradas].reverse()
  const llegadas = []
  const deHoy = cronologico.map((e, i) => ({ ...e, previa: cronologico[i - 1]?.sha ?? null })).filter(e => e.ms >= hoy0).slice(-60)
  await enTandas(deHoy, 12, async e => {
    if (!e.previa) return
    const l = await git(raiz, ['rev-list', e.sha, `^${e.previa}`, '--format=%ct', '--no-commit-header'])
    for (const x of l.out.split(/\r?\n/)) if (Number(x)) llegadas.push({ escrito: Number(x) * 1000, llego: e.ms })
  })
  const empujesHoy = deHoy.filter(e => e.empuje).map(e => e.ms)
  const cuartos = []
  const primero = Math.min(hoy0 + 7 * 60 * MIN, ...llegadas.map(l => l.escrito).filter(h => h >= hoy0), ...esperandoHoy)
  for (let x = Math.floor((primero - hoy0) / (15 * MIN)) * 15 * MIN + hoy0; x <= ahora; x += 15 * MIN) {
    cuartos.push({ ms: x, pendientes: llegadas.filter(l => l.escrito <= x && x < l.llego).length + esperandoHoy.filter(h => h <= x).length })
  }
  const pico = cuartos.reduce((m, c) => (c.pendientes > (m?.pendientes ?? 0) ? c : m), null)

  // El hueco en curso: desde el último empuje de hoy o, si hoy no hubo ninguno, desde el primer commit de hoy que espera.
  const ultimoEmpuje = entradas.find(e => e.empuje)?.ms ?? null
  let huecoDesde = null
  if (esperandoHoy.length) huecoDesde = ultimoEmpuje !== null && ultimoEmpuje >= hoy0 ? ultimoEmpuje : Math.min(...esperandoHoy)
  const huecoMin = huecoDesde === null ? null : (ahora - huecoDesde) / MIN
  return {
    medido: horas !== null,
    sin_integrar: { total: horas ? horas.length : null, de_hoy: esperandoHoy.length, mas_viejo_de_hoy_ms: esperandoHoy.length ? Math.min(...esperandoHoy) : null, mas_viejo_ms: horas?.length ? Math.min(...horas) : null, ramas_miradas: ramas.size, por_rama: porRama },
    empujes_hoy: empujesHoy.length,
    ultimo_empuje_ms: ultimoEmpuje,
    ultima_noticia_ms: entradas[0]?.ms ?? null,
    hueco_min: huecoMin,
    hueco_desde_ms: huecoDesde,
    umbral,
    sobre_el_umbral: huecoMin !== null && umbral.p95_min !== null && huecoMin > umbral.p95_min,
    hoy: { cuartos, empujes: empujesHoy, pico: pico && pico.pendientes > 0 ? pico : null },
  }
}

/** Lo que se despliega, si el repositorio no dice otra cosa en `produccion.rutas`: todo menos documentación y gobierno. */
export const RUTAS_DE_PRODUCCION = Object.freeze(['.', ':(exclude)gobernanza', ':(exclude)docs', ':(exclude).claude', ':(exclude,glob)**/*.md'])
export const POR_DEFECTO = Object.freeze({ migraciones: 'db/migrations', candado: '.vt-suite.lock', principal: 'main', incidentes: '.claude/incidentes.tsv', dias_rama_antigua: 14 })

/** La configuración de un repositorio: lo de repositorios.json manda; después su orquestacion.json; después el valor por defecto. */
export function configurar(entrada, declarado) {
  const raiz = barras(entrada.raiz)
  const texto = (...xs) => xs.find(x => typeof x === 'string' && x.trim() && !path.isAbsolute(x) && !x.split(/[\\/]/).includes('..'))
  return {
    raiz,
    nombre: typeof entrada.nombre === 'string' && entrada.nombre.trim() ? entrada.nombre.trim() : path.posix.basename(raiz),
    // En repositorios.json, `migraciones` es la carpeta. En orquestacion.json la carpeta va en
    // `herramientas.migraciones`, porque ahí `migraciones` es la tabla de reservas.
    migraciones: texto(entrada.migraciones, declarado?.herramientas?.migraciones) ?? POR_DEFECTO.migraciones,
    candado: texto(entrada.candado, declarado?.herramientas?.candado) ?? POR_DEFECTO.candado,
    incidentes: texto(entrada.incidentes, declarado?.herramientas?.incidentes) ?? POR_DEFECTO.incidentes,
    dias_rama_antigua: [entrada.dias_rama_antigua, declarado?.herramientas?.dias_rama_antigua].find(x => Number.isFinite(x) && x > 0) ?? POR_DEFECTO.dias_rama_antigua,
    principal: typeof entrada.principal === 'string' && /^[\w./-]+$/.test(entrada.principal) ? entrada.principal : POR_DEFECTO.principal,
    repo: typeof entrada.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entrada.repo) ? entrada.repo : null,
    credencial: entrada.credencial ?? null,
  }
}

/**
 * Todo lo que se mide de un repositorio. `opciones`: { ahora, sinRed, pedir }. Devuelve además, aparte y sólo
 * para quien arma la ficha pública, `salud`: { commit, bien } o null.
 */
export async function medirRepositorio(entrada, opciones = {}) {
  const ahora = opciones.ahora ?? Date.now()
  const pedir = opciones.pedir ?? pedirDeVerdad
  const sinRed = opciones.sinRed === true
  const raiz = barras(entrada.raiz)
  const declarado = leerJson(path.join(raiz, '.claude', 'orquestacion.json'))
  const cfg = configurar(entrada, declarado)
  const comun = await git(raiz, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!comun.ok) return { repo: { nombre: cfg.nombre, raiz, error: 'no es un repositorio de git, o git no responde' }, salud: null, comun: null }
  const dirComun = barras(comun.out.trim())
  const principalRef = `refs/remotes/origin/${cfg.principal}`

  const FORMATO = '%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)'
  const [wt, refs, stashes, cabeza, reflog, remoto, movido] = await Promise.all([
    git(raiz, ['worktree', 'list', '--porcelain']),
    git(raiz, ['for-each-ref', `--format=${FORMATO}%00%(ahead-behind:${principalRef})`, 'refs/heads']),
    git(raiz, ['stash', 'list', '--format=%ct%x00%gs%x00%H']),
    git(raiz, ['log', '-1', '--format=%H%x00%ct', principalRef]),
    git(raiz, ['reflog', 'show', principalRef, '--format=%H%x00%ct%x00%gs']),
    git(raiz, ['remote', 'get-url', 'origin']),
    sinRed ? Promise.resolve(null) : git(raiz, ['ls-remote', 'origin', `refs/heads/${cfg.principal}`], LIMITE_HTTP_MS),
  ])

  const [shaPrincipal, ctPrincipal] = cabeza.ok ? cabeza.out.trim().split('\0') : [null, null]
  const hayPrincipal = Boolean(shaPrincipal)
  const ramas = new Map()
  let listado = refs
  if (!refs.ok) listado = await git(raiz, ['for-each-ref', `--format=${FORMATO}`, 'refs/heads'])
  for (const linea of listado.out.split(/\r?\n/)) {
    if (!linea) continue
    const [rama, sha, ct, asunto, ab] = linea.split('\0')
    const m = /^(\d+)\s+(\d+)$/.exec((ab ?? '').trim())
    ramas.set(rama, { sha, cuando: Number(ct) * 1000, asunto: (asunto ?? '').slice(0, 120), delante: m ? Number(m[1]) : null, detras: m ? Number(m[2]) : null })
  }
  if (hayPrincipal && !refs.ok) {
    // git anterior a 2.41 no sabe %(ahead-behind): se cuenta rama a rama.
    await enTandas([...ramas.entries()], 12, async ([rama, r]) => {
      const c = await git(raiz, ['rev-list', '--left-right', '--count', `${principalRef}...refs/heads/${rama}`])
      const m = /^(\d+)\s+(\d+)/.exec(c.out.trim())
      if (c.ok && m) {
        r.detras = Number(m[1])
        r.delante = Number(m[2])
      }
    })
  }

  // «WIP on <rama>: …» y «On <rama>: …» son las dos formas en que git anota de qué rama salió una entrada.
  const stash = new Map()
  const revisados = Array.isArray(declarado?.herramientas?.stash_revisados) ? declarado.herramientas.stash_revisados.filter(x => typeof x === 'string' && x.trim()) : []
  let stashSinRiesgo = 0
  for (const linea of stashes.ok ? stashes.out.split(/\r?\n/) : []) {
    const [ct, asunto, sha] = linea.split('\0')
    const m = /^(?:WIP on|On) ([^:]+):/.exec(asunto ?? '')
    if (!m || m[1].startsWith('(')) continue
    let sinRiesgo = revisados.some(x => (asunto ?? '').includes(x.trim()))
    if (!sinRiesgo && hayPrincipal && sha) {
      // Los ficheros que la entrada toca, y si tal como quedaron en ella ya están así en la rama principal remota.
      const tocados = await git(raiz, ['diff', '--name-only', `${sha}^1`, sha])
      const ficheros = tocados.ok ? tocados.out.split(/\r?\n/).filter(Boolean) : []
      if (ficheros.length && ficheros.length <= 300) {
        const igual = await git(raiz, ['diff', '--quiet', sha, principalRef, '--', ...ficheros])
        sinRiesgo = igual.codigo === 0
      }
    }
    if (sinRiesgo) {
      stashSinRiesgo++
      continue
    }
    if (!stash.has(m[1])) stash.set(m[1], [])
    stash.get(m[1]).push(Number(ct) * 1000)
  }

  const ctx = { ahora, ramas, stash, cfg, principalRef: hayPrincipal ? principalRef : null }
  const medidos = await enTandas(leerArboles(wt.out), Math.max(4, Math.min(16, os.cpus().length)), (a, i) => medirArbol(a, i, ctx))
  const todos = medidos.map(m => m.arbol)

  // Remoto movido: lo que el remoto dice ahora frente a lo que este repositorio vio la última vez. Sin fetch.
  let remotoAhora = null
  if (movido && movido.ok) remotoAhora = /^([0-9a-f]{40,64})\s/.exec(movido.out)?.[1] ?? null
  const remotoMedido = Boolean(movido && movido.ok && remotoAhora)
  const movidoMs = reflog.ok ? Number(reflog.out.split(/\r?\n/)[0]?.split('\0')[1]) * 1000 || null : null
  const origen = {
    rama: `origin/${cfg.principal}`,
    commit: shaPrincipal ? shaPrincipal.slice(0, 9) : null,
    commit_cuando: ctPrincipal ? instante(Number(ctPrincipal) * 1000) : null,
    movido_por_ultima_vez: movidoMs ? instante(movidoMs) : null,
    movido_ms: movidoMs,
    remoto: remotoMedido ? remotoAhora.slice(0, 9) : 'sin medir',
    remoto_movido: remotoMedido && shaPrincipal ? remotoAhora !== shaPrincipal : null,
    por_detras: todos.filter(a => (a.detras ?? 0) > 0).map(a => ({ rama: a.rama, ruta: a.ruta, detras: a.detras })),
  }

  // Control: lo declarado (versionado) y lo decidido (local). Si el local no existe todavía, vale lo que el
  // versionado traiga de antes de la 2.1.1, igual que en el mod.
  const rutaLocal = path.join(raiz, '.claude', 'orquestacion.local.json')
  const local = leerJson(rutaLocal)
  let control = { tiene: false, asignaciones: [], fuera: [], esperas_caducadas: [], local: 'sin medir', local_hace_min: null, desfasado: false }
  if (declarado) {
    const estado = { ...declarado, ...(local ? { asignaciones: local.asignaciones ?? {} } : {}) }
    let localMs = null
    try {
      localMs = fs.statSync(rutaLocal).mtimeMs
    } catch {
      localMs = null
    }
    const min = localMs === null ? null : (ahora - localMs) / MIN
    // Lo declarado frente a lo medido: una espera escrita cuya rama ya llegó entera a la rama principal remota.
    const caducadas = []
    for (const [clave, d] of Object.entries(declarado.declarado ?? {})) {
      if (!d?.espera || !/^\d+$/.test(clave) || !hayPrincipal) continue
      const suyas = [...ramas.entries()].filter(([rama]) => new RegExp(`^[^/]+/${clave}$`).test(rama))
      if (!suyas.length || suyas.some(([, x]) => x.delante !== 0)) continue
      const nombrada = await git(raiz, ['log', '-1', '--format=%H', '-E', `--grep=#${clave}([^0-9]|$)`, principalRef])
      if (nombrada.ok && nombrada.out.trim()) caducadas.push(Number(clave))
    }
    control = { tiene: true, ...controlDe(estado), esperas_caducadas: caducadas, local: localMs === null ? 'sin fichero local: el control no decidió aquí' : instante(localMs), local_ms: localMs === null ? null : Math.round(localMs), local_hace_min: min, desfasado: min !== null && min > MIN_CONTROL }
  }

  // Ramas antiguas: su último commit tiene más días que el umbral y no son la rama de una asignación vigente.
  // No generan ningún cuello ni salen en la tabla principal: van aparte, en una lista cerrada.
  const conAsignacion = new Set(control.asignaciones.filter(a => a.estado === 'vigente').map(a => a.issue))
  const limiteAntigua = cfg.dias_rama_antigua * 24 * 60 * MIN
  const antiguas = new Set()
  for (const [rama, r] of ramas) {
    const issue = trabajadorDe(rama, false).issue
    if (ahora - r.cuando > limiteAntigua && !(issue !== null && conAsignacion.has(issue))) antiguas.add(rama)
  }
  // El árbol principal nunca es antiguo: es donde trabaja la sesión.
  if (todos[0]?.rama) antiguas.delete(todos[0].rama)
  for (const a of todos) a.antigua = a.principal ? false : a.rama ? antiguas.has(a.rama) : a.ultimo_commit ? ahora - a.ultimo_commit.ms > limiteAntigua : false
  const vivas = new Map([...ramas.entries()].filter(([rama]) => !antiguas.has(rama)))

  const integracion = hayPrincipal
    ? await medirIntegracion(raiz, principalRef, reflog, vivas, ahora, opciones.umbrales)
    : { medido: false, sin_integrar: { total: null, de_hoy: 0, mas_viejo_ms: null, ramas_miradas: ramas.size, por_rama: [] }, empujes_hoy: 0, ultimo_empuje_ms: null, ultima_noticia_ms: null, hueco_min: null, hueco_desde_ms: null, umbral: umbralDeHuecos([], ahora), sobre_el_umbral: false, hoy: { cuartos: [], empujes: [], pico: null } }
  let incidentes = null
  for (const ruta of [path.join(raiz, cfg.incidentes), ...(opciones.salida ? [path.join(opciones.salida, 'incidentes.tsv')] : [])]) {
    try {
      incidentes = incidentesDe(fs.readFileSync(ruta, 'utf8'), ahora)
      break
    } catch {
      // sin registro en esa ruta
    }
  }

  const issuesPrincipal = new Set(control.asignaciones.filter(a => a.trabajador === 'claude').map(a => a.issue))
  const migraciones = await medirMigraciones(raiz, cfg, hayPrincipal ? principalRef : null, vivas, medidos.filter(m => !m.arbol.antigua), declarado, issuesPrincipal)

  // Una issue con trabajo en dos árboles: lo que dice el control y lo que dicen las ramas <agente>/<número>.
  // Sólo es grave si los dos tocaron los mismos ficheros: lo que cada rama cambió desde su base común con la
  // principal, más lo que su árbol tiene sin confirmar.
  const porIssue = new Map()
  const anotarTrabajo = (issue, clave, arbol) => {
    if (issue === null || !clave) return
    if (!porIssue.has(issue)) porIssue.set(issue, new Map())
    if (!porIssue.get(issue).has(clave) || arbol) porIssue.get(issue).set(clave, arbol ?? porIssue.get(issue).get(clave) ?? null)
  }
  for (const a of control.asignaciones) {
    const suRama = `${a.trabajador}/${a.issue}`
    anotarTrabajo(a.issue, a.trabajador, a.trabajador === 'claude' ? medidos[0] : vivas.has(suRama) ? { arbol: { rama: suRama }, rutas: [] } : null)
  }
  for (const m of medidos) if (!m.arbol.principal && !m.arbol.antigua) anotarTrabajo(m.arbol.issue, m.clave, m)
  const repartidas = []
  for (const [issue, quienes] of [...porIssue.entries()].sort((a, b) => a[0] - b[0])) {
    if (quienes.size < 2) continue
    const tocados = []
    for (const m of quienes.values()) {
      if (!m) continue
      const ficheros = new Set(m.rutas.filter(r => !r.endsWith('/')).map(barras))
      if (hayPrincipal && m.arbol.rama) {
        const d = await git(raiz, ['diff', '--name-only', `${principalRef}...refs/heads/${m.arbol.rama}`])
        for (const f of d.ok ? d.out.split(/\r?\n/) : []) if (f) ficheros.add(f)
      }
      tocados.push(ficheros)
    }
    // Si una rama contiene entera a la otra (una sale de la otra, o ya la integró), coincidir en ficheros no es un choque.
    const susRamas = [...quienes.values()].map(m => m?.arbol.rama).filter(Boolean)
    let contenida = false
    if (susRamas.length === 2) {
      const [ab, ba] = await Promise.all([git(raiz, ['rev-list', '--count', `refs/heads/${susRamas[0]}..refs/heads/${susRamas[1]}`]), git(raiz, ['rev-list', '--count', `refs/heads/${susRamas[1]}..refs/heads/${susRamas[0]}`])])
      contenida = (ab.ok && ab.out.trim() === '0') || (ba.ok && ba.out.trim() === '0')
    }
    const comunes = tocados.length >= 2 && !contenida ? [...tocados[0]].filter(f => tocados.slice(1).some(t => t.has(f))).sort() : []
    repartidas.push({ issue, quienes: [...quienes.keys()], arboles: [...quienes.entries()].map(([clave, m]) => m?.arbol.rama ?? NOMBRE[clave] ?? clave), ficheros_comunes: comunes.slice(0, 3), comunes: comunes.length })
  }

  // GitHub: sólo con credencial declarada y sólo a api.github.com. El valor vive en esta función y no sale de ella.
  const repoGh = cfg.repo ?? (remoto.ok ? repoDeGitHub(remoto.out) : null)
  const github = { repo: repoGh, credencial: { estado: cfg.credencial ? 'sin medir' : 'sin declarar', cuando: null }, issues_abiertas: 'sin medir', cerradas_hoy: 'sin medir', despliegue: { estado: 'sin medir', commit: null }, no_avanzan: null }
  const shaParaDesplegar = remotoAhora ?? shaPrincipal
  if (cfg.credencial && !sinRed) {
    const valor = leerCredencial(raiz, cfg.credencial)
    if (!valor) github.credencial = { estado: 'sin medir', nota: 'la variable no está en el fichero declarado', cuando: instante(ahora) }
    else {
      const cabeceras = { authorization: `Bearer ${valor}`, accept: 'application/vnd.github+json', 'user-agent': 'consumo-index', 'x-github-api-version': '2022-11-28' }
      const quien = await pedir('https://api.github.com/user', { headers: cabeceras, redirect: 'error' })
      if (quien.status === 200) github.credencial = { estado: 'vigente', cuando: instante(ahora) }
      else if (quien.status === 401) github.credencial = { estado: 'rechazada (401)', cuando: instante(ahora) }
      else github.credencial = { estado: 'sin medir', nota: quien.status ? `GitHub respondió ${Number(quien.status)}` : 'GitHub no respondió', cuando: instante(ahora) }
      if (github.credencial.estado === 'vigente' && repoGh) {
        const [duena, nombre] = repoGh.split('/')
        const hoy = new Date(ahora)
        hoy.setHours(0, 0, 0, 0)
        const consulta = 'query($o:String!,$n:String!,$q:String!){repository(owner:$o,name:$n){issues(states:OPEN,first:100){totalCount nodes{number labels(first:30){nodes{name}}}}} search(query:$q,type:ISSUE,first:1){issueCount}}'
        const [cuentas, estadoCommit] = await Promise.all([
          pedir('https://api.github.com/graphql', {
            method: 'POST',
            headers: { ...cabeceras, 'content-type': 'application/json' },
            body: JSON.stringify({ query: consulta, variables: { o: duena, n: nombre, q: `repo:${repoGh} is:issue closed:>=${hoy.toISOString().slice(0, 19)}Z` } }),
            redirect: 'error',
          }),
          shaParaDesplegar ? pedir(`https://api.github.com/repos/${repoGh}/commits/${shaParaDesplegar}/status`, { headers: cabeceras, redirect: 'error' }) : Promise.resolve({ status: 0, texto: '' }),
        ])
        try {
          const d = cuentas.status === 200 ? JSON.parse(cuentas.texto).data : null
          if (Number.isInteger(d?.repository?.issues?.totalCount)) github.issues_abiertas = d.repository.issues.totalCount
          if (Number.isInteger(d?.search?.issueCount)) github.cerradas_hoy = d.search.issueCount
          // Las abiertas que no pueden avanzar solas, cada una contada una vez y por su primera causa. Sin títulos.
          const nodos = d?.repository?.issues?.nodes
          if (Array.isArray(nodos)) {
            const cuenta = { espera: 0, etiqueta: 0, xl: 0 }
            let denominador = 0
            for (const nodo of nodos) {
              const etiquetas = (nodo?.labels?.nodes ?? []).map(e => String(e?.name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
              if (etiquetas.some(e => /^(type:)?(epic|epica)$/.test(e))) continue
              denominador++
              if (declarado?.declarado?.[String(nodo.number)]?.espera) cuenta.espera++
              else if (etiquetas.some(e => /^(bloquead[ao]|blocked|decision-humana|type:decision)$/.test(e))) cuenta.etiqueta++
              else if (etiquetas.some(e => /^peso:\s*xl$/.test(e))) cuenta.xl++
            }
            // Sólo números: sirven para saber si lo declarado habla de una issue que ya no está abierta.
            github.abiertas_numeros = nodos.map(nodo => nodo.number).filter(Number.isInteger)
            github.no_avanzan = { total: cuenta.espera + cuenta.etiqueta + cuenta.xl, denominador, ...cuenta, miradas: nodos.length, abiertas: Number.isInteger(github.issues_abiertas) ? github.issues_abiertas : nodos.length }
          }
        } catch {
          // sin medir
        }
        try {
          const d = estadoCommit.status === 200 ? JSON.parse(estadoCommit.texto) : null
          if (d && typeof d.state === 'string') {
            const sinNada = Number(d.total_count) === 0
            const dicho = ['success', 'pending', 'failure', 'error'].includes(d.state) ? d.state : 'sin medir'
            github.despliegue = { estado: sinNada ? 'sin despliegue' : dicho, commit: String(shaParaDesplegar).slice(0, 9) }
          }
        } catch {
          // sin medir
        }
      }
    }
  }

  // Producción: lo que publica la URL de salud, y nada más. Que el commit sea otro no basta: sólo es un problema
  // si entre lo desplegado y la principal cambió código de lo que se despliega (las rutas de `produccion.rutas`).
  const url = urlDeSalud(declarado)
  const produccion = { declarada: Boolean(url), estado: 'sin medir', commit: null, bien: null, coincide: null, codigo: null }
  let salud = null
  if (url && !sinRed) {
    const r = await pedir(url, {})
    salud = saludDe(r.status >= 200 && r.status < 300 ? r.texto : '')
    produccion.estado = 'medida'
    produccion.commit = salud.commit
    produccion.bien = salud.bien
    const esperado = remotoAhora ?? shaPrincipal
    produccion.coincide = salud.commit && esperado ? esperado.startsWith(salud.commit) || salud.commit.startsWith(esperado) : null
    if (produccion.coincide === true) produccion.codigo = 'igual'
    else if (produccion.coincide === false && shaPrincipal) {
      const esta = await git(raiz, ['rev-parse', '--verify', '--quiet', `${salud.commit}^{commit}`])
      if (!esta.ok || !esta.out.trim()) produccion.codigo = 'no comparable'
      else {
        const rutas = Array.isArray(declarado?.produccion?.rutas) && declarado.produccion.rutas.every(x => typeof x === 'string' && x && !x.startsWith('-')) && declarado.produccion.rutas.length ? declarado.produccion.rutas : RUTAS_DE_PRODUCCION
        const d = await git(raiz, ['diff', '--quiet', esta.out.trim(), shaPrincipal, '--', ...rutas])
        produccion.codigo = d.codigo === 0 ? 'igual' : d.codigo === 1 ? 'distinto' : 'no comparable'
      }
    }
  }

  const limiteEfimero = HORAS_EFIMERO_ACTIVO * 60
  const efimerosTodos = todos.filter(a => a.efimero)
  const activos = efimerosTodos.filter(a => a.actividad_hace_min !== null && a.actividad_hace_min <= limiteEfimero)
  const repo = {
    nombre: cfg.nombre,
    raiz,
    origen,
    arboles: todos.filter(a => !a.antigua && (!a.efimero || activos.includes(a))),
    // Ramas antiguas con algo dentro (un árbol, commits por delante o stash): una línea cada una, sin alarma.
    antiguas: [...antiguas]
      .map(rama => {
        const r = ramas.get(rama)
        const arbol = todos.find(a => a.rama === rama && !a.efimero)
        return { rama, dias: Math.floor((ahora - r.cuando) / (24 * 60 * MIN)), ultimo_commit_ms: r.cuando, delante: r.delante, detras: r.detras, con_arbol: Boolean(arbol), sin_confirmar: arbol?.sin_confirmar ?? 0, stash: stash.get(rama)?.length ?? 0 }
      })
      .filter(x => x.con_arbol || (x.delante ?? 0) > 0 || x.stash > 0)
      .sort((a, b) => a.dias - b.dias),
    dias_rama_antigua: cfg.dias_rama_antigua,
    repartidas,
    efimeros: {
      total: efimerosTodos.length,
      con_cambios: efimerosTodos.filter(a => (a.sin_confirmar ?? 0) > 0).length,
      con_commits_por_delante: efimerosTodos.filter(a => (a.delante ?? 0) > 0).length,
      activos_en_2h: activos.length,
      inactivos: efimerosTodos.filter(a => !activos.includes(a)),
    },
    arboles_vistos: todos.length,
    // El stash de una rama antigua, o de una rama que ya no existe y cuya última entrada es antigua, no avisa.
    stash: [...stash.entries()].map(([rama, veces]) => ({ rama, entradas: veces.length, desde: instante(Math.min(...veces)), antigua: ramas.has(rama) ? antiguas.has(rama) : ahora - Math.max(...veces) > limiteAntigua })),
    integracion,
    incidentes,
    migraciones,
    candados: todos.filter(a => a.candado).map(a => ({ ruta: a.ruta, rama: a.rama, ...a.candado })),
    control,
    github,
    produccion,
  }
  // Datos que sólo sirven para decidir los cuellos; no se publican.
  const interno = {
    principalMs: ctPrincipal ? Number(ctPrincipal) * 1000 : null,
    stashMs: new Map([...stash.entries()].map(([rama, veces]) => [rama, Math.min(...veces)])),
    commitMs: new Map(medidos.map(m => [m.arbol.ruta, m.ultimoCommitMs])),
    claves: new Map(medidos.map(m => [m.arbol.ruta, m.clave])),
    todos,
    localMs: control.local_hace_min === null ? null : ahora - control.local_hace_min * MIN,
  }
  for (const a of [...repo.arboles, ...repo.efimeros.inactivos]) {
    const e = estadoDeArbol(a)
    a.estado = e.palabra
    a.forma = e.forma
  }
  repo.stash_sin_riesgo = stashSinRiesgo
  return { repo, salud, comun: dirComun, interno }
}

// ── Cuellos de botella ──────────────────────────────────────────────────────────────────────────────

const ORDEN_GRAVEDAD = { alta: 0, media: 1 }

/**
 * Los cuellos de un repositorio. `vistos` recuerda cuándo se vio por primera vez lo que no trae hora propia
 * (una credencial rechazada, un remoto movido): { antes, ahora } con clave → milisegundos.
 */
export function cuellosDe(medido, ahora, vistos = { antes: {}, ahora: {} }) {
  const { repo, interno } = medido
  if (repo.error || !interno) return []
  const cuellos = []
  const desdeVisto = clave => {
    const k = `${repo.raiz}|${clave}`
    const ms = typeof vistos.antes[k] === 'number' ? vistos.antes[k] : ahora
    vistos.ahora[k] = ms
    return ms
  }
  // `datos`: lo que el control necesita para decidir con esta señal, sin tener que leer la frase.
  const poner = (gravedad, tipo, que, desdeMs, datos = {}) => cuellos.push({ gravedad, tipo, que, desde: instante(desdeMs), desde_ms: Math.round(desdeMs), repositorio: repo.nombre, datos })
  const deLaSesion = a => a.principal || interno.claves.get(a.ruta) === 'claude'
  const p95 = repo.integracion.umbral
  const etiqueta = a => (a.principal ? `sesión principal (${a.rama ?? 'HEAD suelto'})` : `${a.trabajador ?? 'sin identificar'} (${a.rama ?? 'HEAD suelto'})`)

  if (repo.github.credencial.estado === 'rechazada (401)') poner('alta', 'credencial', 'GitHub rechazó la credencial declarada (401): issues y despliegue quedan sin medir hasta renovarla.', desdeVisto('credencial'), { http: 401, hora: repo.github.credencial.cuando })

  // Un aviso por número de migración: todo lo que se sabe de él, en una frase.
  const porNumero = new Map()
  const delNumero = numero => {
    const k = Number(numero)
    if (!porNumero.has(k)) porNumero.set(k, { numero, repetida: null, sinReserva: [], ajena: [] })
    return porNumero.get(k)
  }
  for (const rep of repo.migraciones.repetidos) delNumero(rep.numero).repetida = rep
  for (const a of repo.migraciones.alertas.filter(x => x.tipo === 'reserva')) (a.reserva_de === null ? delNumero(a.numero).sinReserva : delNumero(a.numero).ajena).push(a)
  for (const [, x] of [...porNumero.entries()].sort((a, b) => a[0] - b[0])) {
    const partes = []
    if (x.repetida) {
      const mismoNombre = new Set(x.repetida.entre.map(e => e.fichero)).size === 1
      partes.push(`El número de migración ${x.numero} está tomado ${x.repetida.entre.length} veces${mismoNombre ? ', con el mismo nombre de fichero y contenido distinto' : ''}: ${x.repetida.entre.map(e => `${e.rama} (${e.fichero})`).join(' y ')}.`)
      if (x.sinReserva.length) partes.push(`Además no está reservado para ${x.sinReserva.map(a => a.donde).join(' ni para ')}.`)
      if (x.ajena.length) partes.push(`Además su reserva es de la #${x.ajena[0].reserva_de}, y lo usa ${x.ajena.map(a => a.donde).join(' y ')}.`)
    } else if (x.sinReserva.length) partes.push(`La migración ${x.numero} está en uso en ${x.sinReserva.map(a => a.donde).join(' y en ')} y no está reservada para ella.${x.ajena.length ? ` Además su reserva es de la #${x.ajena[0].reserva_de}, y la usa ${x.ajena.map(a => a.donde).join(' y ')}.` : ''}`)
    else partes.push(`La migración ${x.numero} está en uso en ${x.ajena.map(a => a.donde).join(' y en ')} y su reserva es de la #${x.ajena[0].reserva_de}.`)
    const sitios = [...(x.repetida?.entre.map(e => e.rama) ?? []), ...x.sinReserva.map(a => a.sitio), ...x.ajena.map(a => a.sitio)].filter(Boolean)
    const arbolPrincipal = interno.todos[0]?.rama ?? null
    poner('alta', 'migracion', partes.join(' '), desdeVisto(`migracion:${Number(x.numero)}`), { numero: x.numero, ramas: [...new Set(sitios)], issues: [...new Set(sitios.map(sitio => trabajadorDe(sitio, false).issue).filter(n => n !== null))], sesion: sitios.some(sitio => sitio === arbolPrincipal || /^claude\//.test(sitio)) })
  }

  const g = repo.integracion
  if (g.sobre_el_umbral && g.sin_integrar.de_hoy > 0) {
    poner('alta', 'hueco', `Hace ${hace(g.hueco_min)} que nada llega a ${repo.origen.rama} y hay ${g.sin_integrar.de_hoy} commits de hoy esperando. Lo habitual es menos: el percentil 95 de los huecos entre empujes es ${g.umbral.p95_min} min (n = ${g.umbral.n}).`, g.hueco_desde_ms, { hueco_min: Math.round(g.hueco_min), p95_min: g.umbral.p95_min, n: g.umbral.n, commits_de_hoy: g.sin_integrar.de_hoy })
  }
  for (const issue of repo.control.esperas_caducadas) poner('media', 'caducado', `Lo declarado está caducado: la #${issue} figura en espera y su rama ya llegó a ${repo.origen.rama}.`, desdeVisto(`caducado:${issue}`), { issue })

  for (const a of repo.migraciones.alertas.filter(x => x.tipo !== 'reserva')) poner('alta', a.tipo, a.que, desdeVisto(a.clave))
  for (const numero of repo.migraciones.reservas.sin_fichero) {
    // La tabla no dice cuándo se reservó: las dos horas corren desde la primera vez que este guion la vio vacía.
    const desde = desdeVisto(`reserva-vacia:${numero}`)
    if (ahora - desde > HORAS_RESERVA_VACIA * 60 * MIN) poner('media', 'reserva-vacia', `La migración ${numero} lleva ${hace((ahora - desde) / MIN)} reservada sin fichero en ningún árbol ni rama.`, desde)
  }

  const conTrabajo = interno.todos.filter(a => !a.falta && !a.antigua && ((a.sin_confirmar ?? 0) > 0 || (a.delante ?? 0) > 0))
  if (repo.origen.remoto_movido === true && conTrabajo.length) {
    const nombres = conTrabajo.filter(a => !a.efimero).map(a => a.rama ?? a.ruta).slice(0, 6)
    const efimeros = conTrabajo.filter(a => a.efimero).length
    poner('alta', 'remoto', `El remoto movió ${repo.origen.rama} (${repo.origen.commit} → ${repo.origen.remoto}) y hay trabajo debajo: ${[...nombres, efimeros ? `${efimeros} árboles efímeros` : ''].filter(Boolean).join(', ')}. Hay que traerlo antes de empujar.`, desdeVisto(`remoto:${repo.origen.remoto}`), { de: repo.origen.commit, a: repo.origen.remoto, sesion: conTrabajo.some(deLaSesion) })
  }

  const d = repo.github.despliegue
  if (d.estado === 'failure' || d.estado === 'error') poner('alta', 'despliegue', `El despliegue del último commit de ${repo.origen.rama} (${d.commit}) falló.`, desdeVisto(`despliegue:${d.commit}`))
  else if ((d.estado === 'sin despliegue' || d.estado === 'pending') && repo.origen.remoto_movido !== true && interno.principalMs !== null && ahora - interno.principalMs > MIN_DESPLIEGUE * MIN) {
    poner('alta', 'despliegue', `El último commit de ${repo.origen.rama} (${d.commit}) lleva ${hace((ahora - interno.principalMs) / MIN)} ${d.estado === 'pending' ? 'con el despliegue pendiente' : 'sin despliegue'}.`, interno.principalMs)
  }

  const p = repo.produccion
  if (p.estado === 'medida') {
    const principal = repo.origen.remoto !== 'sin medir' ? repo.origen.remoto : repo.origen.commit
    if (p.bien !== true) poner('alta', 'produccion', 'Producción responde con problemas o no responde.', desdeVisto('produccion:salud'), { codigo: 'caida' })
    // Otro commit no basta: sólo es un cuello si entre los dos cambió código de lo que se despliega.
    else if (p.codigo === 'distinto') poner('alta', 'produccion', `Producción corre ${p.commit} y ${repo.origen.rama} está en ${principal}: entre los dos cambió código de lo que se despliega.`, desdeVisto(`produccion:${p.commit}`), { codigo: 'distinto', produccion: p.commit, principal })
    else if (p.codigo === 'no comparable') poner('media', 'produccion', `Producción corre ${p.commit}, que no está en este clon: no comparable con ${repo.origen.rama} (${principal}).`, desdeVisto(`produccion:${p.commit}`), { codigo: 'no comparable', produccion: p.commit, principal })
  }

  // Una issue con trabajo en dos árboles. Es una pregunta, no una alarma, salvo que los dos tocaran los mismos ficheros.
  for (const x of repo.repartidas) {
    const donde = x.arboles.join(' y ')
    if (x.comunes > 0) poner('alta', 'duplicada', `La #${x.issue} tiene trabajo en dos árboles (${donde}) y los dos tocaron los mismos ficheros: ${x.ficheros_comunes.join(', ')}${x.comunes > x.ficheros_comunes.length ? ` y ${x.comunes - x.ficheros_comunes.length} más` : ''}. Hay que repartirlo antes de integrar.`, desdeVisto(`duplicada:${x.issue}`))
    else poner('media', 'duplicada', `La #${x.issue} tiene trabajo en dos árboles (${donde}): confirmar que el reparto es intencionado.`, desdeVisto(`duplicada:${x.issue}`))
  }

  // Un aviso por árbol: si es una pieza que espera o trabajo a medias, y lo que tenga en el stash, en la misma frase.
  // Las piezas que esperan más de DIAS_PIEZA_VIEJA días son deuda real, pero van juntas en un aviso: no tapan lo de hoy.
  const conAviso = new Set()
  const viejas = []
  const vigentes = new Set(repo.control.asignaciones.filter(x => x.estado === 'vigente').map(x => x.issue))
  for (const a of interno.todos) {
    if (a.efimero || a.falta || a.antigua) continue
    const commitMs = interno.commitMs.get(a.ruta)
    const minCommit = commitMs ? (ahora - commitMs) / MIN : null
    const enStash = a.stash > 0 ? `${a.stash} ${a.stash === 1 ? 'entrada' : 'entradas'} en el stash` : ''
    const clave = interno.claves.get(a.ruta)
    const quien = { rama: a.rama, trabajador: a.principal ? 'sesión principal' : a.trabajador, issue: a.issue, principal: a.principal, externo: !a.principal && clave !== null && clave !== 'claude', asignada: a.issue !== null && vigentes.has(a.issue) }
    if ((a.sin_confirmar ?? 0) > 0 && minCommit !== null && minCommit > MIN_SIN_CONFIRMAR) {
      const reciente = a.mas_reciente ? `; el más reciente, tocado hace ${hace(a.mas_reciente.hace_min)}` : ''
      poner('media', 'sin-confirmar', `${etiqueta(a)} tiene trabajo sin confirmar: ${a.sin_confirmar} ${a.sin_confirmar === 1 ? 'fichero' : 'ficheros'}${reciente}${enStash ? `, y ${enStash}` : ''}. Su último commit es de hace ${hace(minCommit)}. No significa que esté parado.`, commitMs, { ...quien, sin_confirmar: a.sin_confirmar, stash: a.stash, sin_moverse_min: Math.round(a.actividad_hace_min ?? minCommit), sin_moverse: (a.actividad_hace_min ?? minCommit) > MIN_SIN_CONFIRMAR })
      if (a.rama) conAviso.add(a.rama)
    } else if ((a.delante ?? 0) > 0 && a.sin_confirmar === 0 && minCommit !== null && minCommit > MIN_SIN_INTEGRAR) {
      // En el árbol principal sólo cuentan los commits de hoy: lo que lleva días sin empujar es una decisión, no un olvido.
      const deHoy = a.principal ? repo.integracion.sin_integrar.por_rama.find(x => x.rama === a.rama)?.de_hoy ?? 0 : null
      if (a.principal && !deHoy) continue
      const datos = { ...quien, commits: a.principal ? deHoy : a.delante, espera_min: Math.round(minCommit), p95_min: p95.p95_min, n: p95.n, stash: a.stash }
      if (a.rama) conAviso.add(a.rama)
      if (!a.principal && minCommit > DIAS_PIEZA_VIEJA * 24 * 60) {
        viejas.push({ a, commitMs, minCommit, datos })
        continue
      }
      const que = a.principal
        ? `${a.rama ?? 'El árbol principal'} local lleva ${deHoy} ${deHoy === 1 ? 'commit de hoy' : 'commits de hoy'} sin empujar a ${repo.origen.rama}; el último, hace ${hace(minCommit)}`
        : `Pieza terminada sin integrar: ${etiqueta(a)} lleva ${a.delante} commits por delante de ${repo.origen.rama}, árbol limpio, esperando hace ${hace(minCommit)}`
      poner('media', 'pieza', `${que}${enStash ? `; además tiene ${enStash}` : ''}.`, commitMs, datos)
    } else if (a.stash > 0 && !a.principal && clave !== null && clave !== 'claude') {
      // Sólo stash, en el árbol de un trabajador externo: es trabajo a medias, y el control tiene que saber de quién.
      poner('media', 'stash', `La rama ${a.rama} tiene ${enStash}: trabajo guardado que no está en ningún commit.`, interno.stashMs.get(a.rama) ?? ahora, { ...quien, sin_confirmar: 0, stash: a.stash, sin_moverse_min: minCommit === null ? null : Math.round(minCommit), sin_moverse: minCommit !== null && minCommit > MIN_SIN_CONFIRMAR })
      if (a.rama) conAviso.add(a.rama)
    }
  }
  if (viejas.length === 1) {
    const [v] = viejas
    poner('media', 'pieza', `Pieza terminada sin integrar: ${etiqueta(v.a)} lleva ${v.a.delante} commits por delante de ${repo.origen.rama}, árbol limpio, esperando hace ${hace(v.minCommit)}${v.a.stash > 0 ? `; además tiene ${v.a.stash} en el stash` : ''}.`, v.commitMs, v.datos)
  } else if (viejas.length > 1) {
    viejas.sort((x, y) => x.minCommit - y.minCommit)
    poner('media', 'piezas-viejas', `${viejas.length} ramas terminadas hace más de ${DIAS_PIEZA_VIEJA} días sin integrar: ${viejas.map(v => `${v.a.rama} (${v.a.delante} commits, hace ${hace(v.minCommit)})`).join(', ')}.`, Math.min(...viejas.map(v => v.commitMs)), { piezas: viejas.map(v => v.datos) })
  }
  for (const s of repo.stash) {
    if (s.antigua || conAviso.has(s.rama)) continue
    poner('media', 'stash', `La rama ${s.rama} tiene ${s.entradas} ${s.entradas === 1 ? 'entrada' : 'entradas'} en el stash: trabajo guardado que no está en ningún commit.`, interno.stashMs.get(s.rama) ?? ahora, { rama: s.rama, stash: s.entradas, externo: false })
  }

  return cuellos
}

export function ordenar(cuellos) {
  return [...cuellos].sort((a, b) => ORDEN_GRAVEDAD[a.gravedad] - ORDEN_GRAVEDAD[b.gravedad] || b.desde_ms - a.desde_ms || a.que.localeCompare(b.que))
}

// ── Las salidas ─────────────────────────────────────────────────────────────────────────────────────

// La piel es la plantilla canónica de Datito v1: su bloque :root y sus reglas, copiados tal cual. Sin CDN, sin
// fuentes remotas, sin librerías y sin degradados. Debajo, los añadidos del tablero: sólo disposición, con los
// tokens de la plantilla y ningún color nuevo.
const ESTILO = `
  :root{--tinta:#1a1a1a;--suave:#666;--linea:#d8d8d8;--fondo:#faf9f7;
        --azul:#2563eb;--rojo:#dc2626;--verde:#059669;--ambar:#d97706;--morado:#7c3aed}
  *{box-sizing:border-box}
  body{margin:0;padding:2rem 1rem;background:var(--fondo);color:var(--tinta);
       font:16px/1.7 "Segoe UI",system-ui,sans-serif}
  main{max-width:1100px;margin:0 auto}
  h1{font-size:1.7rem;margin:0 0 .3rem}
  h2{font-size:1.2rem;margin:2.6rem 0 .7rem;padding-top:1.3rem;border-top:1px solid var(--linea)}
  h3{font-size:1rem;margin:1.6rem 0 .4rem;color:#374151}
  .sub{color:var(--suave);margin:0 0 2rem}
  table{border-collapse:collapse;width:100%;font-size:.9rem;margin:.9rem 0}
  th,td{border:1px solid var(--linea);padding:.5rem .65rem;text-align:left;vertical-align:top}
  th{background:var(--fondo);font-weight:600}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  code{background:#f1f0ee;padding:.1rem .35rem;border-radius:4px;font-size:.9em}
  .clave{background:#eff6ff;border-left:3px solid var(--azul);padding:.85rem 1.1rem;margin:1.1rem 0}
  .nota{background:#fffbeb;border-left:3px solid var(--ambar);padding:.85rem 1.1rem;margin:1.1rem 0;font-size:.94rem}
  .peligro{background:#fef2f2;border-left:3px solid var(--rojo);padding:.85rem 1.1rem;margin:1.1rem 0}
  .met{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem;margin-top:1rem}
  .met div{background:var(--fondo);border-radius:8px;padding:.75rem .5rem;text-align:center}
  .met .n{font-size:1.4rem;font-weight:700;font-variant-numeric:tabular-nums}
  .met .e{font-size:.7rem;color:var(--suave);text-transform:uppercase;letter-spacing:.04em;margin-top:.2rem}
  .lbl{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--suave);margin:1.1rem 0 .25rem}
  .fuente{font-size:.76rem;color:var(--suave);font-family:ui-monospace,Consolas,monospace}
  .panel{background:#fff;border:1px solid var(--linea);border-radius:10px;padding:1.2rem;margin:1.2rem 0}
  details{background:#fff;border:1px solid var(--linea);border-radius:9px;padding:.9rem 1.2rem;margin:.7rem 0}
  summary{cursor:pointer;font-weight:600;color:var(--azul);list-style:none}
  summary::-webkit-details-marker{display:none}
  summary:before{content:"▸ ";font-weight:700}
  details[open] summary:before{content:"▾ "}
  details[open] summary{margin-bottom:.7rem}
  footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--linea);color:var(--suave);font-size:.85rem}

  /* Añadidos del tablero: sólo disposición, con los tokens de la plantilla. Ningún color nuevo. */
  .aviso{display:grid;grid-template-columns:7.5rem 1fr;gap:.2rem 1rem;align-items:baseline}
  @media(max-width:520px){.aviso{grid-template-columns:1fr}}
  .aviso .cifra{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
  .aviso .pie,.pie{font-size:.78rem;color:var(--suave)}
  .ley{font-size:.8rem;color:var(--suave);margin:.4rem 0 .2rem}
  .nm{font-weight:700;letter-spacing:.02em;border:1px dashed var(--suave);padding:0 .3rem;border-radius:3px;white-space:nowrap}
  th.num{text-align:right}
  .tabla-ancha{overflow-x:auto}
  table.fija{table-layout:fixed;min-width:860px}
  table.fija td{overflow-wrap:anywhere}
  .met span{display:block}
  .panel h3:first-child{margin-top:0}
`

function horaLocal(ms) {
  const d = new Date(ms)
  return `${diaLocal(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const soloHora = ms => horaLocal(ms).slice(11)
/** Una hora en la zona local, con la UTC en `title`. */
const hora = ms => `<span title="${instante(ms)}">${horaLocal(ms)}</span>`
/** Un «hace cuánto», con la hora exacta (local y UTC) en `title`. */
const relativo = (ms, ahora) => `<span title="${horaLocal(ms)} · ${instante(ms)}">hace ${hace((ahora - ms) / MIN)}</span>`
const NUMERICAS = /^(Issue|Número|Commits|Sin confirmar|En el stash|Por delante|Incidentes|Más viejo|Último commit, hace)/
const tabla = (cabeceras, filas) => `<div class="tabla-ancha"><table>\n<tr>${cabeceras.map(c => `<th${NUMERICAS.test(c) ? ' class="num"' : ''}>${c}</th>`).join('')}</tr>\n${filas.join('\n')}\n</table></div>`
const celda = (texto, numerica = false) => `<td${numerica ? ' class="num"' : ''}>${texto}</td>`
const fila = celdas => `<tr>${celdas.join('')}</tr>`
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`
const coma = (x, decimales = 1) => x.toFixed(decimales).replace('.', ',')

/** El estado de un árbol en palabras, medido: nunca «parado» ni «inactivo», que es algo que git no sabe. */
export function estadoDeArbol(a) {
  if (a.falta) return { palabra: 'la carpeta ya no existe', forma: '□', rango: 4, espera: 0 }
  const commit = a.ultimo_commit?.hace_min ?? null
  const actividad = a.actividad_hace_min
  if ((a.sin_confirmar ?? 0) > 0) {
    if (actividad !== null && actividad <= MIN_SIN_CONFIRMAR) return { palabra: 'trabajando', forma: '●', rango: 2, espera: 0 }
    return { palabra: 'tiene trabajo a medias', forma: '■', rango: 0, espera: actividad ?? 0 }
  }
  if (a.stash > 0) return { palabra: 'tiene trabajo a medias (en el stash)', forma: '■', rango: 0, espera: commit ?? 0 }
  if ((a.delante ?? 0) > 0) {
    if (commit !== null && commit <= MIN_SIN_INTEGRAR) return { palabra: 'trabajando', forma: '●', rango: 2, espera: 0 }
    return { palabra: `${a.principal ? 'sin empujar' : 'terminada, sin integrar'} hace ${hace(commit)} (aprox.: desde su último commit)`, forma: '■', rango: 1, espera: commit ?? 0 }
  }
  if (a.sin_confirmar === null) return { palabra: 'NO MEDIDO: git no respondió en ese árbol', forma: '□', rango: 3, espera: 0 }
  return { palabra: `sin cambios locales y sin commits por delante${(a.detras ?? 0) > 0 ? `; ${plural(a.detras, 'commit', 'commits')} por detrás de la principal` : ''}`, forma: '○', rango: 3, espera: 0 }
}

const porLoQueEspera = arboles => arboles.map(a => ({ a, e: estadoDeArbol(a) })).sort((x, y) => x.e.rango - y.e.rango || y.e.espera - x.e.espera)

/** Los gráficos son SVG en línea: una serie, una escala, ejes con unidad, y sus cifras debajo. */
function graficoDeHoy(integ, rama) {
  const { cuartos, empujes, pico } = integ.hoy
  if (!cuartos.length) return ''
  const W = 860
  const alto = 190
  const [mIzq, mInf, mSup] = [44, 34, 14]
  const h = alto - mInf - mSup
  const maximo = Math.max(4, ...cuartos.map(c => c.pendientes))
  const paso = Math.max(1, Math.ceil(maximo / 4))
  const ancho = (W - mIzq - 8) / cuartos.length
  const x = ms => mIzq + ((ms - cuartos[0].ms) / (15 * MIN)) * ancho
  const partes = []
  for (let v = 0; v <= maximo; v += paso) {
    const y = mSup + h - (h * v) / maximo
    partes.push(`<line x1="${mIzq}" y1="${y.toFixed(1)}" x2="${W - 8}" y2="${y.toFixed(1)}" stroke="var(--linea)" stroke-width="1"/>`, `<text x="${mIzq - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--suave)">${v}</text>`)
  }
  for (const c of cuartos) {
    const alt = (h * c.pendientes) / maximo
    if (alt > 0) partes.push(`<rect x="${(x(c.ms) + 1).toFixed(1)}" y="${(mSup + h - alt).toFixed(1)}" width="${Math.max(1, ancho - 2).toFixed(1)}" height="${alt.toFixed(1)}" fill="var(--azul)"><title>${soloHora(c.ms)}: ${plural(c.pendientes, 'commit', 'commits')} sin llegar a ${escapar(rama)}</title></rect>`)
    if (new Date(c.ms).getMinutes() === 0) partes.push(`<text x="${x(c.ms).toFixed(1)}" y="${alto - 6}" font-size="11" fill="var(--suave)">${soloHora(c.ms)}</text>`)
  }
  for (const e of empujes) partes.push(`<text x="${x(e).toFixed(1)}" y="${mSup + h + 13}" text-anchor="middle" font-size="11" fill="var(--tinta)">▲<title>empuje a las ${soloHora(e)}</title></text>`)
  partes.push(`<text x="6" y="11" font-size="11" fill="var(--suave)">commits</text>`)
  return [
    `<h3>Hoy: commits escritos y sin llegar a <code>${escapar(rama)}</code>, cada 15 min</h3>`,
    `<div class="tabla-ancha"><svg viewBox="0 0 ${W} ${alto}" width="100%" role="img" aria-label="Commits escritos y sin integrar, cada 15 minutos de hoy" style="display:block;min-width:640px;background:#fff;border:1px solid var(--linea);border-radius:8px">${partes.join('')}</svg></div>`,
    `<p class="ley">Por qué este gráfico: la forma (subida sostenida y caída) hace visible un hueco de integración que una cifra suelta no enseña. Barra: commits con hora anterior a ese cuarto que aún no estaban en <code>${escapar(rama)}</code>. ▲ bajo el eje: un empuje. Unidad: commits. Ventana: hoy, ${soloHora(cuartos[0].ms)} a ${soloHora(cuartos[cuartos.length - 1].ms)} (n = ${cuartos.length} cuartos de hora). Cifras: ${pico ? `máximo de ${plural(pico.pendientes, 'commit', 'commits')} a las ${soloHora(pico.ms)}` : `0 commits esperando en los ${cuartos.length} cuartos de hora mirados`}; ${plural(empujes.length, 'empuje', 'empujes')} hoy${empujes.length ? ` (${empujes.map(soloHora).join(', ')})` : ''}. Fuente: reflog de <code>${escapar(rama)}</code> y git log.</p>`,
  ].join('\n')
}

/** Arma la página. `sabe` reúne todo lo que queda NO MEDIDO, para la lista del final. */
function pintor(datos) {
  const ahora = datos.foto_ms
  const noSabe = []
  const nm = (que, motivo) => {
    if (!noSabe.some(x => x.que === que)) noSabe.push({ que, motivo })
    return `<span class="nm">NO MEDIDO</span> <span class="pie">${escapar(motivo)}</span>`
  }
  const motivoDeGitHub = r => {
    if (datos.sin_red) return 'esta foto se tomó sin red'
    const c = r.github.credencial
    if (c.estado === 'sin declarar') return 'el repositorio no declara credencial de GitHub'
    if (c.estado === 'rechazada (401)') return 'GitHub rechazó la credencial'
    if (c.estado !== 'vigente') return c.nota ?? 'GitHub no respondió'
    return r.github.repo ? 'GitHub no respondió a tiempo' : 'el remoto no es de GitHub'
  }

  // Anchos repartidos y fijos: el estado va primero y nunca se corta; a 1100 px cabe sin desplazamiento.
  const COLUMNAS = [['Estado medido', 25], ['Trabajador', 11], ['Issue', 6], ['Rama', 18], ['Último commit', 10], ['Sin confirmar', 12], ['Stash', 7], ['Respecto de la principal', 11]]
  function tablaDeArboles(arboles, control) {
    const vigentes = new Set((control?.asignaciones ?? []).filter(x => x.estado === 'vigente').map(x => x.issue))
    const sesionConIssue = (control?.asignaciones ?? []).some(x => x.estado === 'vigente' && x.trabajador === 'claude')
    // Primero quien tiene una asignación vigente o actividad en las últimas 24 h, por lo que más espera; después el resto.
    const delante = a => (a.principal ? sesionConIssue : a.issue !== null && vigentes.has(a.issue)) || (a.actividad_hace_min !== null && a.actividad_hace_min <= 24 * 60)
    const ordenadas = arboles.map(a => ({ a, e: estadoDeArbol(a), grupo: delante(a) ? 0 : 1 })).sort((x, y) => x.grupo - y.grupo || x.e.rango - y.e.rango || y.e.espera - x.e.espera)
    const filas = ordenadas.map(({ a, e }) => {
      const quien = a.principal ? 'sesión principal' : a.trabajador ?? (a.efimero ? 'agente efímero' : null)
      const commit = a.ultimo_commit ? `<span title="${escapar(a.ultimo_commit.asunto)} · ${horaLocal(a.ultimo_commit.ms)} · ${instante(a.ultimo_commit.ms)}">hace ${hace((ahora - a.ultimo_commit.ms) / MIN)}</span>` : nm(`último commit de ${a.rama ?? a.ruta}`, 'git no respondió')
      const sucio =
        a.sin_confirmar === null
          ? nm(`ficheros sin confirmar de ${a.rama ?? a.ruta}`, a.falta ? 'la carpeta ya no existe' : 'git no respondió en ese árbol')
          : a.sin_confirmar === 0
            ? '—'
            : `<span title="${a.mas_reciente ? `el más reciente: ${escapar(a.mas_reciente.fichero)} · ${horaLocal(a.mas_reciente.ms)}` : 'ficheros sin confirmar'}">${a.sin_confirmar}${a.mas_reciente ? ` · hace ${hace((ahora - a.mas_reciente.ms) / MIN)}` : ''}</span>`
      return fila([
        celda(`${e.forma} <strong>${escapar(e.palabra)}</strong>${a.candado ? `<br><span class="pie">candado de suite: ${escapar(a.candado.quien)}, hace ${hace(a.candado.hace_min)}</span>` : ''}`),
        celda(quien === null ? '—' : escapar(quien)),
        celda(a.issue === null ? '—' : `#${a.issue}`, true),
        celda(`<code>${escapar(a.rama ?? `HEAD suelto ${a.cabeza ?? ''}`)}</code>`),
        celda(commit),
        celda(sucio, true),
        celda(a.stash ? String(a.stash) : '—', true),
        celda(a.delante === null ? nm(`commits por delante de ${a.rama ?? a.ruta}`, 'no hay rama principal remota con la que comparar') : `+${a.delante} / −${a.detras}`, true),
      ])
    })
    const numericas = new Set(['Issue', 'Sin confirmar', 'Stash', 'Respecto de la principal'])
    return [
      '<div class="tabla-ancha"><table class="fija">',
      `<colgroup>${COLUMNAS.map(([, ancho]) => `<col style="width:${ancho}%">`).join('')}</colgroup>`,
      `<tr>${COLUMNAS.map(([nombre]) => `<th${numericas.has(nombre) ? ' class="num"' : ''}>${nombre}</th>`).join('')}</tr>`,
      ...filas,
      '</table></div>',
    ].join('\n')
  }

  function dondeEspera(r) {
    const p = []
    const g = r.integracion
    const rama = r.origen.rama
    const ventana = `foto de las ${soloHora(ahora)}`
    // 1 · El hueco desde el último empuje, frente al P95 guardado.
    const u = g.umbral
    const umbral =
      u.p95_min !== null
        ? `El percentil 95 de los huecos entre empujes de un mismo día es ${u.p95_min} min (n = ${plural(u.n, 'hueco', 'huecos')}, ${plural(u.dias, 'día', 'días')} con empujes desde el ${u.desde}; umbral calculado el ${u.calculado}): 95 de cada 100 huecos son más cortos.`
        : `Umbral: n = ${plural(u.n, 'hueco', 'huecos')} entre empujes en el reflog de este clon, insuficiente para un percentil 95 (hacen falta ${N_MINIMO_P95}); sin umbral no hay aviso.`
    const noticia = g.ultima_noticia_ms ? ` Última noticia de <code>${escapar(rama)}</code> en este clon: ${relativo(g.ultima_noticia_ms, ahora)}.` : ''
    if (!g.medido) p.push(`<div class="nota aviso"><div class="cifra">${nm(`commits sin integrar de ${r.nombre}`, 'no hay rama principal remota en este clon')}</div><div><strong>commits escritos y sin llegar a la rama principal.</strong></div></div>`)
    else {
      if (g.hueco_min === null) {
        p.push(`<div class="clave aviso"><div class="cifra">0 commits</div><div><strong>escritos hoy que estén esperando llegar a <code>${escapar(rama)}</code>: no hay hueco de integración que medir.</strong><div class="pie">Se miraron ${plural(g.sin_integrar.ramas_miradas, 'rama local', 'ramas locales')} · ${plural(g.empujes_hoy, 'empuje', 'empujes')} hoy · ${ventana} · fuente: git log y reflog. ${umbral}${noticia}</div></div></div>`)
      } else {
        p.push(
          `<div class="${g.sobre_el_umbral ? 'peligro' : 'nota'} aviso"><div class="cifra">${hace(g.hueco_min)}</div><div><strong>${g.ultimo_empuje_ms !== null && g.hueco_desde_ms === g.ultimo_empuje_ms ? `sin ningún empuje a <code>${escapar(rama)}</code>, desde las ${soloHora(g.hueco_desde_ms)}` : `desde el primer commit de hoy que espera (${soloHora(g.hueco_desde_ms)}), sin ningún empuje a <code>${escapar(rama)}</code> hoy`}, con ${plural(g.sin_integrar.de_hoy, 'commit de hoy esperando', 'commits de hoy esperando')}.</strong>${g.sobre_el_umbral ? ' Es MAYOR que lo habitual.' : ''}<div class="pie">${umbral} Ventana: hoy · ${ventana} · fuente: reflog de ${escapar(rama)}.${noticia}</div></div></div>`,
        )
      }
      // 2 · Commits escritos y sin llegar.
      const s = g.sin_integrar
      p.push(
        `<div class="${s.total ? 'nota' : 'clave'} aviso"><div class="cifra">${plural(s.total, 'commit', 'commits')}</div><div><strong>escritos y sin llegar a <code>${escapar(rama)}</code>${s.total ? `; ${s.de_hoy} de ${s.total} son de hoy, y el más viejo es de ${relativo(s.mas_viejo_ms, ahora)}` : ''}.</strong><div class="pie">n = ${plural(s.ramas_miradas, 'rama local mirada', 'ramas locales miradas')}, cada commit contado una vez · ${ventana} · fuente: git rev-list. Cuándo quedó terminada cada pieza: ${nm('cuándo quedó terminada cada pieza', 'nadie registra el suceso «terminada»; se aproxima con el último commit')}</div></div></div>`,
      )
    }
    // 3 · Issues abiertas que no pueden avanzar solas.
    const b = r.github.no_avanzan
    if (!b) p.push(`<div class="nota aviso"><div class="cifra">${nm('issues abiertas que no pueden avanzar solas', motivoDeGitHub(r))}</div><div><strong>issues abiertas que no pueden avanzar solas</strong> (espera declarada, etiqueta de bloqueo, peso XL sin partir).</div></div>`)
    else {
      p.push(
        `<div class="${b.total ? 'nota' : 'clave'} aviso"><div class="cifra">${b.total} de ${b.denominador}</div><div><strong>issues abiertas no pueden avanzar solas:</strong> ${b.espera} con espera declarada, ${b.etiqueta} con etiqueta de bloqueo o de decisión, ${b.xl} de peso XL sin partir.<div class="pie">Denominador: las ${b.denominador} abiertas que no son épica, de ${b.miradas} leídas${b.miradas < b.abiertas ? ` (hay ${b.abiertas} abiertas: sólo se leen las primeras ${b.miradas})` : ''} · ${ventana} · fuente: GitHub y .claude/orquestacion.json. Desde cuándo espera cada una: ${nm('desde cuándo espera cada issue bloqueada', 'ni la etiqueta ni el campo «espera» guardan la hora')}</div></div></div>`,
      )
    }
    // 4 · Incidentes de coordinación.
    const k = r.incidentes
    if (!k) p.push(`<div class="nota aviso"><div class="cifra">${nm(`incidentes de coordinación de ${r.nombre}`, 'el repositorio no tiene registro de incidentes (.claude/incidentes.tsv)')}</div><div><strong>incidentes de coordinación hoy.</strong></div></div>`)
    else {
      p.push(
        `<div class="${k.hoy ? 'nota' : 'clave'} aviso"><div class="cifra">${k.hoy} hoy</div><div><strong>incidentes de coordinación registrados${k.hoy ? `; ${k.en_causa_repetida} de ${k.hoy} son de una causa que se repitió en el día` : ''}.</strong><div class="pie">n = ${plural(k.dias_con_registro, 'día', 'días')} de registro${k.dias_con_registro < 5 ? ': es una línea base, no una tasa' : ''}${k.hoy === 0 ? (k.dia_cerrado ? ' · el día tiene su línea de cierre: se miró y no hubo' : ' · sin línea de cierre del día: puede que nadie haya mirado') : ''} · ventana: hoy · fuente: registro de incidentes. Detalle en «Coordinación».</div></div></div>`,
      )
    }
    if (g.medido) {
      p.push(graficoDeHoy(g, rama))
      const s = g.sin_integrar
      if (s.por_rama.length) {
        const visibles = s.por_rama.slice(0, 12)
        p.push(
          tabla(
            ['Rama con commits sin integrar', 'Commits', 'Más viejo, hace', 'Último commit, hace'],
            visibles.map(x => fila([celda(`<code>${escapar(x.rama)}</code>`), celda(String(x.commits), true), celda(x.mas_viejo_ms ? hace((ahora - x.mas_viejo_ms) / MIN) : nm(`commit más viejo de ${x.rama}`, 'git no respondió'), true), celda(hace((ahora - x.ultimo_ms) / MIN), true)])),
          ),
          `<p class="pie">Ramas locales con commits por delante de <code>${escapar(rama)}</code>: se muestran ${visibles.length} de ${s.por_rama.length}, las de último commit más reciente primero. Un commit que está en dos ramas sale en las dos: por eso la suma de la columna puede pasar del total de arriba. ${ventana} · fuente: git.</p>`,
        )
      }
    }
    // Las cifras del momento, de lo medido en los árboles.
    const estados = r.arboles.filter(a => !a.efimero).map(a => ({ a, e: estadoDeArbol(a) }))
    const todos = r.arboles.map(a => estadoDeArbol(a))
    const piezas = estados.filter(x => x.e.rango === 1)
    const esperan = estados.filter(x => x.e.rango <= 1).sort((x, y) => y.e.espera - x.e.espera)
    const mirados = `n = ${plural(estados.length, 'árbol mirado', 'árboles mirados')} · ${ventana} · git`
    const ficha = (valor, etiqueta, pie) => `<div><span class="n">${valor}</span><span class="e">${escapar(etiqueta)}</span><span class="fuente">${escapar(pie)}</span></div>`
    p.push(
      '<div class="met">',
      ficha(String(piezas.length), 'piezas terminadas sin integrar (aprox.)', `más de ${MIN_SIN_INTEGRAR} min desde su último commit · ${mirados}`),
      ficha(String(todos.filter(e => e.rango === 0 || e.rango === 2).length), 'frentes con trabajo en curso', `árboles con cambios o con commits recientes · n = ${plural(todos.length, 'árbol', 'árboles')} con los efímeros activos · ${ventana} · git`),
      ficha(esperan.length ? hace(esperan[0].e.espera) : '0 min', 'la espera más larga', esperan.length ? `${esperan[0].a.rama ?? 'HEAD suelto'} · ${mirados}` : `0 piezas esperando · ${mirados}`),
      '</div>',
    )
    return p.join('\n')
  }

  function panelDeRepositorio(r) {
    const p = ['<div class="panel">', `<h3>${escapar(r.nombre)}</h3>`]
    const o = r.origen
    const remoto = o.remoto_movido === null ? nm(`si el remoto de ${r.nombre} se movió`, datos.sin_red ? 'esta foto se tomó sin red' : 'el remoto no respondió en 5 s') : o.remoto_movido ? `<strong>MOVIDO</strong> a <code>${o.remoto}</code>: hay que traerlo antes de empujar` : 'igual que aquí'
    p.push(
      '<p class="lbl">Medido · git y disco</p>',
      `<p><code>${escapar(o.rama)}</code> en <code>${o.commit ?? 'ningún commit'}</code>${o.movido_ms ? ` · se movió en este clon por última vez ${relativo(o.movido_ms, ahora)}` : ''} · remoto: ${remoto}${o.por_detras.length ? ` · ${plural(o.por_detras.length, 'árbol va', 'árboles van')} por detrás` : ''}</p>`,
      tablaDeArboles(r.arboles, r.control),
      `<p class="pie">n = ${plural(r.arboles.length, 'árbol', 'árboles')} en la tabla, de ${r.arboles_vistos} vistos. Primero quien tiene una asignación vigente o actividad en las últimas 24 h, por lo que más espera. ■ espera · ● en curso · ○ sin nada pendiente · □ sin medir. «Sin confirmar»: ficheros, y hace cuánto se tocó el más reciente. «Stash»: entradas. «Respecto de la principal»: commits por delante / por detrás de ${escapar(o.rama)}. «—»: no hay. El asunto del último commit y las horas exactas, al pasar el cursor. «Trabajo a medias» no significa parado: git no sabe si alguien está escribiendo.</p>`,
    )
    const ef = r.efimeros
    if (ef.inactivos.length) {
      p.push('<details>', `<summary>${ef.inactivos.length} árboles de agentes efímeros sin actividad en ${HORAS_EFIMERO_ACTIVO} h · ${ef.con_cambios} de ${ef.total} con cambios sin confirmar · ${ef.con_commits_por_delante} de ${ef.total} con commits por delante</summary>`, tablaDeArboles(ef.inactivos, null), '</details>')
    }
    const m = r.migraciones
    p.push('<p class="lbl">Medido · migraciones</p>')
    if (!m.existe) p.push(`<p>Este repositorio no tiene <code>${escapar(m.carpeta)}</code>: 0 migraciones miradas.</p>`)
    else {
      const difiere = m.difiere_del_declarado ? ` El declarado dice <code>${escapar(m.reservas.siguiente_libre_declarado)}</code>: <strong>NO COINCIDE</strong>, vale el medido.` : m.reservas.siguiente_libre_declarado ? ' Coincide con el declarado.' : ''
      p.push(`<div class="clave"><strong>Siguiente número libre, medido: <code>${m.proximo_libre}</code></strong>.${difiere} <span class="pie">${escapar(m.carpeta)} · última en ${escapar(o.rama)}: ${m.ultimo_en_principal ?? 'ninguna'} · se miraron ${escapar(o.rama)}, las ramas con commits por delante y los ficheros sin confirmar de cada árbol</span></div>`)
      if (m.reservas.tabla.length) {
        p.push(
          tabla(
            ['Número', 'Issue', 'Reservada para', 'Usada en', 'Estado'],
            m.reservas.tabla.map(t =>
              fila([
                celda(`<code>${escapar(t.numero)}</code>`, true),
                celda(t.issue === null ? 'sin issue' : `#${t.issue}`, true),
                celda(t.reservada ? escapar(t.reservada_para) : m.reservas.declaradas ? '<strong>sin reserva</strong>' : 'el repositorio no declara reservas'),
                celda(t.usada_en.length ? t.usada_en.map(u => `<code>${escapar(u)}</code>`).join(', ') : 'ningún sitio'),
                celda(escapar(t.estado)),
              ]),
            ),
          ),
        )
      } else p.push(`<p>0 números tomados o reservados fuera de <code>${escapar(o.rama)}</code>.</p>`)
    }
    const c = r.control
    p.push('<p class="lbl">Declarado · el control (.claude/orquestacion.json y su fichero local)</p>')
    if (!c.tiene) p.push('<p>Este repositorio no tiene <code>.claude/orquestacion.json</code>: nadie declaró quién tiene qué.</p>')
    else {
      if (c.asignaciones.length) {
        p.push(tabla(['Issue', 'La tiene', 'Paso sin hacer', 'Situación declarada'], c.asignaciones.map(a => fila([celda(`#${a.issue}`, true), celda(escapar(a.quien)), celda(escapar(a.paso)), celda(`${a.estado}${a.espera ? ' · ■ espera al dueño' : ''}${c.esperas_caducadas.includes(a.issue) ? ' · <strong>CADUCADA: su rama ya llegó a la principal</strong>' : ''}`)]))))
      } else p.push('<p>0 issues asignadas en lo declarado.</p>')
      p.push(`<p>Fuera: ${c.fuera.length ? c.fuera.map(escapar).join(', ') : 'nadie'} · última decisión escrita: ${c.local_ms ? relativo(c.local_ms, ahora) : escapar(c.local)} (el control sólo reescribe cuando su decisión cambia: la edad sola no indica nada)${c.esperas_caducadas.length ? ` · esperas declaradas que lo medido contradice: ${c.esperas_caducadas.map(n => `#${n}`).join(', ')}` : ''}</p>`)
    }
    if (r.stash_sin_riesgo) p.push(`<p class="pie">${plural(r.stash_sin_riesgo, 'entrada del stash no avisa', 'entradas del stash no avisan')}: su contenido ya está en ${escapar(o.rama)}, o el repositorio las declara revisadas en herramientas.stash_revisados.</p>`)
    if (r.antiguas.length) {
      p.push(
        '<details>',
        `<summary>Ramas antiguas (${r.antiguas.length}): último commit hace más de ${r.dias_rama_antigua} días y sin asignación vigente. No generan avisos.</summary>`,
        '<ul>',
        ...r.antiguas.map(x => `<li><code>${escapar(x.rama)}</code> · último commit hace ${x.dias} días${x.delante === null ? '' : ` · +${x.delante} / −${x.detras} commits respecto de la principal`}${x.con_arbol ? ` · con árbol${x.sin_confirmar ? `, ${plural(x.sin_confirmar, 'fichero sin confirmar', 'ficheros sin confirmar')}` : ''}` : ''}${x.stash ? ` · ${plural(x.stash, 'entrada', 'entradas')} en el stash` : ''}</li>`),
        '</ul>',
        '</details>',
      )
    }
    p.push('</div>')
    return p.join('\n')
  }

  const { cuellos, repositorios } = datos
  const validos = repositorios.filter(r => !r.error)
  const n = repositorios.length
  const partes = [
    '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<!-- datito:template:v1 -->\n<meta http-equiv="refresh" content="30">\n<title>Index de trabajo</title>',
    `<style>${ESTILO}</style>\n</head>\n<body>\n<main>`,
    `<div class="peligro" id="vieja" hidden><strong>ATENCIÓN.</strong> <span id="vieja-texto">El index no se está actualizando: la última foto tiene más de ${MIN_FOTO_VIEJA} minutos.</span></div>`,
    `<h1>Index de trabajo${n === 1 ? ` · ${escapar(repositorios[0].nombre)}` : ''}</h1>`,
    `<p class="sub">Foto de las ${hora(ahora)} (hora local) · <span id="edad">recién tomada</span> · ${plural(n, 'repositorio', 'repositorios')} · medido en ${coma(datos.duracion_ms / 1000)} s${datos.sin_red ? ' · sin red: GitHub, remoto y producción quedan sin medir' : ''} · muestra, no decide</p>`,
    `<noscript><div class="nota">Sin JavaScript esta página no puede decir la edad de la foto: compárala con tu reloj. Si pasa de ${MIN_FOTO_VIEJA} minutos, el index no se está actualizando.</div></noscript>`,
    `<div class="clave"><strong>Para qué sirve esta página.</strong> Ver dónde está esperando el trabajo y por qué, antes de mirar cuánto se cerró. No mide a quienes trabajan: mide el recorrido de cada pieza. Cada cifra lleva su unidad, su <em>n</em> y su ventana; lo que no se pudo medir dice <span class="nm">NO MEDIDO</span>, nunca 0.</div>`,
  ]

  // 1 · Avisos: los cuellos de botella. Los de gravedad alta, todos; con los de media se completa hasta tres.
  partes.push(`<h2>Avisos · ${plural(cuellos.length, 'cuello de botella', 'cuellos de botella')}</h2>`)
  const bloque = c => `<div class="${c.gravedad === 'alta' ? 'peligro' : 'nota'}"><strong>${c.gravedad === 'alta' ? '■ ALTA' : '▲ MEDIA'}</strong> · ${escapar(c.que)}<div class="pie">desde las ${hora(c.desde_ms)} (${relativo(c.desde_ms, ahora)}) · ${escapar(c.repositorio)}</div></div>`
  if (!cuellos.length) {
    partes.push(`<div class="clave"><strong>Nada espera fuera de lo habitual</strong> en la foto de las ${hora(ahora)}. Se comparó contra: piezas con más de ${MIN_SIN_INTEGRAR} min sin integrar, trabajo sin confirmar con más de ${MIN_SIN_CONFIRMAR} min desde el último commit, hueco de empujes mayor que su percentil 95, números de migración repetidos o sin reserva y remoto movido.</div>`)
  } else {
    const altas = cuellos.filter(c => c.gravedad === 'alta')
    const visibles = cuellos.slice(0, Math.max(3, altas.length))
    const resto = cuellos.slice(visibles.length)
    partes.push(...visibles.map(bloque))
    if (resto.length) partes.push('<details>', `<summary>${plural(resto.length, 'aviso más, de gravedad media', 'avisos más, de gravedad media')}</summary>`, ...resto.map(bloque), '</details>')
  }

  // 2 · Dónde espera el trabajo ahora.
  partes.push('<h2>Dónde espera el trabajo ahora</h2>')
  if (!validos.length) partes.push(`<div class="nota">${nm('dónde espera el trabajo', 'no hay ningún repositorio que medir: instala con instalar.mjs o pasa --raiz')}</div>`)
  for (const r of validos) {
    if (validos.length > 1) partes.push(`<h3>${escapar(r.nombre)}</h3>`)
    partes.push(dondeEspera(r))
  }

  // 3 · Coordinación.
  partes.push('<h2>Coordinación · incidentes por causa</h2>')
  for (const r of validos) {
    const k = r.incidentes
    const nombre = validos.length > 1 ? `${escapar(r.nombre)}: ` : ''
    if (!k) partes.push(`<p>${nombre}${nm(`incidentes de coordinación de ${r.nombre}`, 'el repositorio no tiene registro de incidentes (.claude/incidentes.tsv)')}</p>`)
    else if (!k.hoy) partes.push(`<p>${nombre}0 incidentes registrados hoy, en un registro de ${plural(k.dias_con_registro, 'día', 'días')}${k.dia_cerrado ? ', con la línea de cierre del día puesta' : '; el día no tiene línea de cierre, así que puede que nadie haya mirado'}.</p>`)
    else {
      partes.push(
        tabla(['Causa', 'Incidentes hoy', 'De los de hoy'], k.por_causa.map(c => fila([celda(escapar(c.causa)), celda(String(c.n), true), celda(`<svg width="160" height="10" role="img" aria-label="${c.n} de ${k.hoy}"><rect width="160" height="10" fill="#fff" stroke="var(--linea)"/><rect width="${Math.round((160 * c.n) / k.hoy)}" height="10" fill="var(--azul)"/></svg> <span class="pie">${c.n} de ${k.hoy}</span>`)]))),
        `<p class="pie">${nombre}n = ${plural(k.hoy, 'incidente', 'incidentes')} hoy · ${k.detectados_solos} de ${k.hoy} los habría visto un guion; el resto consta porque alguien lo anotó · coste medido: ${k.coste_min} min en ${k.con_coste} de ${k.hoy}${k.con_coste < k.hoy ? `; en los otros ${k.hoy - k.con_coste}, ${nm('coste de los incidentes sin minutos anotados', 'el registro trae «?» en el coste')}` : ''} · se cuenta por causa, no por quién · ventana: hoy · fuente: registro de incidentes (${plural(k.dias_con_registro, 'día', 'días')} de registro).</p>`,
      )
    }
  }
  if (!validos.length) partes.push(`<p>${nm('incidentes de coordinación', 'no hay repositorios')}</p>`)
  else {
    const de = tipo => cuellos.filter(c => c.tipo === tipo).length
    partes.push(`<p class="pie">Detectores de esta foto, los que ve un guion sin que nadie anote nada: ${plural(de('migracion'), 'número de migración con aviso', 'números de migración con aviso')} · ${plural(de('duplicada'), 'issue con trabajo en dos árboles', 'issues con trabajo en dos árboles')} · ${plural(de('caducado'), 'espera declarada que lo medido contradice', 'esperas declaradas que lo medido contradicen')} · n = ${plural(validos.length, 'repositorio mirado', 'repositorios mirados')} · ventana: foto de las ${soloHora(ahora)} · fuente: git y lo declarado.</p>`)
  }

  const dec = datos.decisiones
  if (dec && dec.cambios > 0) {
    partes.push(`<p>Señales que cambiaron la orden del control: ${dec.senales} en ${plural(dec.cambios, 'cambio de orden', 'cambios de orden')}; ${dec.altas} de gravedad alta. Resueltas: ${dec.resueltas} de ${dec.senales}${dec.duraciones_min.length ? `, en ${dec.mediana_min === null ? dec.duraciones_min.map(m => hace(m)).join(', ') : `${hace(dec.mediana_min)} la mitad de ellas`}` : ''}; siguen vivas ${dec.vivas}; reaparecieron ${dec.reaparecidas}. Tendencia: ${dec.dias >= 7 ? `${coma(dec.dias)} días de registro` : nm('tendencia de las señales del control', `n = ${coma(dec.dias)} días de registro, hacen falta 7: sólo conteo`)} <span class="pie">fuente: decisiones.tsv, calculado con el diario.</span></p>`)
  } else partes.push(`<p>Señales que cambiaron la orden del control: ${nm('señales que cambiaron la orden del control', dec ? 'el registro de decisiones está vacío' : 'no hay registro de decisiones (lo escribe el control del mod cuando una señal cambia su orden) o el cálculo diario aún no lo leyó')}</p>`)

  // 4 · Flujo: lo calcula el guion diario (diario.mjs) y aquí sólo se lee, con su fecha.
  partes.push('<h2>Flujo · entra, sale, cuánto tarda</h2>', '<div class="met">')
  for (const [campo, etiqueta, pie] of [['issues_abiertas', 'issues abiertas', 'foto'], ['cerradas_hoy', 'issues cerradas hoy', 'hoy, hora local']]) {
    const medidos = validos.filter(r => Number.isInteger(r.github[campo]))
    if (medidos.length) partes.push(`<div><span class="n">${medidos.reduce((s, r) => s + r.github[campo], 0)}</span><span class="e">${etiqueta}</span><span class="fuente">n = ${plural(medidos.length, 'repositorio', 'repositorios')} · ${pie} · GitHub, foto de las ${soloHora(ahora)}</span></div>`)
    else partes.push(`<div><span class="n">${nm(etiqueta, validos.length ? motivoDeGitHub(validos[0]) : 'no hay repositorios')}</span><span class="e">${etiqueta}</span></div>`)
  }
  partes.push('</div>')
  const dos = x => (x === null || x === undefined ? null : Number(x.toPrecision(2)))
  const enDias = x => (x < 1 / 24 ? `${Math.round(x * 24 * 60)} min` : x < 1 ? `${coma(dos(x * 24), dos(x * 24) < 10 ? 1 : 0)} h` : `${coma(dos(x), dos(x) < 10 ? 1 : 0)} d`)
  for (const r of validos) {
    const d = r.diario
    const nombre = validos.length > 1 ? `${r.nombre}: ` : ''
    if (!d || !d.medido) {
      const motivo = d?.motivo ?? (r.github.credencial.estado === 'sin declarar' ? 'el repositorio no declara credencial de GitHub, y el cálculo diario la necesita' : 'el cálculo diario todavía no se hizo para este repositorio (corre solo una vez al día, o con «node indice.mjs --diario»)')
      partes.push(
        '<ul>',
        `<li>${escapar(nombre)}Altas y cierres por semana, con los cierres en bloque aparte: ${nm(`altas y cierres por semana de ${r.nombre}`, motivo)}</li>`,
        `<li>${escapar(nombre)}Tiempo de entrega de las issues construidas (mediana, P85, P95): ${nm(`tiempo de entrega de ${r.nombre}`, motivo)}</li>`,
        `<li>${escapar(nombre)}Issues hechas sin ningún commit que las nombre: ${nm(`issues hechas sin commit de ${r.nombre}`, motivo)}</li>`,
        `<li>${escapar(nombre)}Commits sin integrar al cierre de cada día: ${nm(`commits sin integrar al cierre de cada día de ${r.nombre}`, motivo)}</li>`,
        `<li>${escapar(nombre)}Proyección de la cola: ${nm(`proyección de la cola de ${r.nombre}`, motivo)}</li>`,
        '</ul>',
      )
      continue
    }
    const calculado = `calculado ${relativo(datos.diario_calculado_ms, ahora)} (${horaLocal(datos.diario_calculado_ms)}), una vez al día`
    const S = d.semanas
    const completas = S.filter(x => x.completa)
    const W = 860
    // Gráfico: altas frente a cierres por semana; los cierres en bloque, con trama.
    {
      const alto = 230
      const [mIzq, mInf, mSup] = [44, 44, 16]
      const h = alto - mInf - mSup
      const tope = Math.max(4, ...S.map(x => Math.max(x.altas, x.cierres)))
      const paso = (W - mIzq - 8) / S.length
      const bw = Math.max(6, Math.min(60, paso / 2 - 8))
      const g = ['<defs><pattern id="trama" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff"/><rect width="3" height="6" fill="var(--ambar)"/></pattern></defs>']
      for (let v = 0; v <= tope; v += Math.max(1, Math.ceil(tope / 4))) {
        const y = mSup + h - (h * v) / tope
        g.push(`<line x1="${mIzq}" y1="${y.toFixed(1)}" x2="${W - 8}" y2="${y.toFixed(1)}" stroke="var(--linea)" stroke-width="1"/><text x="${mIzq - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--suave)">${v}</text>`)
      }
      S.forEach((x, i) => {
        const cx = mIzq + i * paso + paso / 2
        const ha = (h * x.altas) / tope
        const hf = (h * x.fuera_de_bloque) / tope
        const hb = (h * x.en_bloque) / tope
        if (ha > 0) g.push(`<rect x="${(cx - bw - 1).toFixed(1)}" y="${(mSup + h - ha).toFixed(1)}" width="${bw.toFixed(1)}" height="${ha.toFixed(1)}" fill="var(--azul)"><title>semana del ${x.lunes}: ${x.altas} altas</title></rect>`)
        if (hf > 0) g.push(`<rect x="${(cx + 1).toFixed(1)}" y="${(mSup + h - hf).toFixed(1)}" width="${bw.toFixed(1)}" height="${hf.toFixed(1)}" fill="var(--ambar)"><title>${x.fuera_de_bloque} cierres fuera de bloque</title></rect>`)
        if (hb > 0) g.push(`<rect x="${(cx + 1).toFixed(1)}" y="${(mSup + h - hf - hb).toFixed(1)}" width="${bw.toFixed(1)}" height="${hb.toFixed(1)}" fill="url(#trama)" stroke="var(--ambar)" stroke-width="1"><title>${x.en_bloque} cierres en bloque</title></rect>`)
        g.push(`<text x="${(cx - bw / 2 - 1).toFixed(1)}" y="${(mSup + h - ha - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--tinta)">${x.altas}</text>`)
        g.push(`<text x="${(cx + 1 + bw / 2).toFixed(1)}" y="${(mSup + h - hf - hb - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--tinta)">${x.cierres}</text>`)
        g.push(`<text x="${cx.toFixed(1)}" y="${mSup + h + 16}" text-anchor="middle" font-size="11" fill="var(--suave)">${x.lunes.slice(8)}-${x.lunes.slice(5, 7)}${x.completa ? '' : ' · en curso'}</text>`)
      })
      g.push('<text x="6" y="11" font-size="11" fill="var(--suave)">issues</text>')
      partes.push(
        `<h3>${escapar(nombre)}Altas y cierres por semana</h3>`,
        `<div class="tabla-ancha"><svg viewBox="0 0 ${W} ${alto}" width="100%" role="img" aria-label="Altas y cierres por semana; los cierres en bloque van con trama" style="display:block;min-width:640px;background:#fff;border:1px solid var(--linea);border-radius:8px">${g.join('')}</svg></div>`,
        `<p class="ley">Por qué este gráfico: pone lado a lado lo que entra y lo que sale, y separa a la vista los cierres anotados en bloque del resto. Barra izquierda (lisa, azul): altas. Barra derecha (ámbar): cierres; la parte rayada, cierres en bloque (${MINIMO_BLOQUE} o más con ${HUECO_BLOQUE} min o menos entre uno y otro). Unidad: issues. Ventana: semanas de lunes a domingo, hora local, desde el ${S[0].lunes} (n = ${plural(S.length, 'semana', 'semanas')}, ${completas.length} completas). Fuente: GitHub, ${calculado}.</p>`,
        tabla(
          ['Semana del lunes', 'Issues creadas', 'Issues hechas', 'Issues descartadas', 'Issues neto', 'Cierres en bloque', 'Issues abiertas al final'],
          S.map(x => fila([celda(`${x.lunes}${x.completa ? '' : ` · <strong>en curso</strong>, ${coma(x.dias_transcurridos)} d de 7`}`), celda(String(x.altas), true), celda(String(x.hechas), true), celda(String(x.descartadas), true), celda(`${x.neto > 0 ? '+' : x.neto < 0 ? '−' : ''}${Math.abs(x.neto)}`, true), celda(`${x.en_bloque} de ${x.cierres}`, true), celda(String(x.abiertas_al_final), true)])),
        ),
        `<p class="pie">Neto = creadas − cerradas (hechas y descartadas). La semana en curso va aparte y no entra en ningún resumen. Cierres en bloque en todo el tablero: ${d.bloques.cierres_en_bloque} de ${d.bloques.cierres} cierres, en ${plural(d.bloques.bloques, 'bloque', 'bloques')}${d.bloques.detalle.length ? ` (el mayor, ${d.bloques.detalle[0].n} cierres en ${coma(d.bloques.detalle[0].duracion_min)} min el ${d.bloques.detalle[0].dia})` : ''}: un bloque es una anotación tardía, no trabajo de ese rato. Ritmo semanal: ${completas.length >= 6 ? 'los valores están en la tabla, semana a semana' : `n = ${plural(completas.length, 'semana completa', 'semanas completas')}, insuficiente para resumir (hacen falta 6)`}. ${calculado}.</p>`,
      )
    }
    // Tiempo de entrega de las construidas.
    const e = d.entrega
    const insuf = (que, minimo) => `n = ${e.n}, insuficiente para ${que} (hacen falta ${minimo})`
    partes.push(
      `<div class="${e.p50_dias === null ? 'nota' : 'clave'} aviso"><div class="cifra">${e.p50_dias === null ? nm(`mediana del tiempo de entrega de ${r.nombre}`, insuf('una mediana', 10)) : enDias(e.p50_dias)}</div><div><strong>${escapar(nombre)}tarda la mitad de las issues construidas, del alta al cierre.</strong> ${e.p85_dias === null ? `P85: ${nm(`P85 del tiempo de entrega de ${r.nombre}`, insuf('un P85', 20))}` : `85 de cada 100, menos de ${enDias(e.p85_dias)}.`} ${e.p95_dias === null ? `P95: ${nm(`P95 del tiempo de entrega de ${r.nombre}`, insuf('un P95', 40))}` : `95 de cada 100, menos de ${enDias(e.p95_dias)}.`} ${e.menos_de_1_hora} de ${e.n} se cerraron a menos de una hora de crearse.<div class="pie">n = ${plural(e.n, 'issue construida', 'issues construidas')} (cerradas como hechas, con algún commit que las nombra antes del cierre; sin épicas ni descartadas)${e.desde ? ` · ventana: cierres del ${e.desde} al ${e.hasta}` : ''} · mediana y percentiles, no media · fuente: GitHub y git log, ${calculado}.</div></div></div>`,
    )
    if (e.n > 0) {
      const alto = 190
      const [mIzq, mInf, mSup] = [44, 30, 16]
      const h = alto - mInf - mSup
      const tope = Math.max(4, ...e.histograma.map(x => x.n))
      const paso = (W - mIzq - 8) / e.histograma.length
      const g = []
      for (let v = 0; v <= tope; v += Math.max(1, Math.ceil(tope / 4))) {
        const y = mSup + h - (h * v) / tope
        g.push(`<line x1="${mIzq}" y1="${y.toFixed(1)}" x2="${W - 8}" y2="${y.toFixed(1)}" stroke="var(--linea)" stroke-width="1"/><text x="${mIzq - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--suave)">${v}</text>`)
      }
      e.histograma.forEach((x, i) => {
        const bh = (h * x.n) / tope
        if (bh > 0) g.push(`<rect x="${(mIzq + i * paso + 10).toFixed(1)}" y="${(mSup + h - bh).toFixed(1)}" width="${(paso - 20).toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--azul)"><title>${escapar(x.tramo)}: ${x.n} issues</title></rect>`)
        g.push(`<text x="${(mIzq + i * paso + paso / 2).toFixed(1)}" y="${(mSup + h - bh - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--tinta)">${x.n}</text>`, `<text x="${(mIzq + i * paso + paso / 2).toFixed(1)}" y="${mSup + h + 16}" text-anchor="middle" font-size="11" fill="var(--suave)">${escapar(x.tramo)}</text>`)
      })
      g.push('<text x="6" y="11" font-size="11" fill="var(--suave)">issues</text>')
      partes.push(
        `<div class="tabla-ancha"><svg viewBox="0 0 ${W} ${alto}" width="100%" role="img" aria-label="Distribución del tiempo de entrega de las issues construidas" style="display:block;min-width:640px;background:#fff;border:1px solid var(--linea);border-radius:8px">${g.join('')}</svg></div>`,
        `<p class="ley">Por qué este gráfico: enseña lo que la mediana esconde, un pico por debajo de una hora y una cola de semanas. Barra: issues construidas por tramo de tiempo de entrega. Unidad: issues. Ventana: todo el tablero (n = ${e.n}). Cifras: ${e.histograma.map(x => `${x.tramo}: ${x.n}`).join(' · ')}. Fuente: GitHub, ${calculado}.</p>`,
      )
    }
    partes.push(
      `<div class="${d.hechas_sin_commit.n ? 'nota' : 'clave'} aviso"><div class="cifra">${d.hechas_sin_commit.n} de ${d.hechas_sin_commit.de}</div><div><strong>${escapar(nombre)}issues cerradas como hechas sin ningún commit que las nombre antes del cierre.</strong> De ésas no se sabe con qué se construyeron.<div class="pie">Denominador: las ${d.hechas_sin_commit.de} hechas que no son épica · n = ${d.universo.commits} commits mirados en todas las ramas, ${d.universo.commits_que_nombran_issue} nombran alguna issue · ventana: todo el tablero, desde el ${d.universo.primera_alta} · fuente: GitHub y git log, ${calculado}.</div></div></div>`,
    )
    // Commits sin integrar al cierre de cada día.
    const I = d.inventario
    if (I.length) {
      const alto = 180
      const [mIzq, mInf, mSup] = [44, 30, 16]
      const h = alto - mInf - mSup
      const tope = Math.max(4, ...I.map(x => x.commits))
      const paso = (W - mIzq - 8) / I.length
      const g = []
      for (let v = 0; v <= tope; v += Math.max(1, Math.ceil(tope / 4))) {
        const y = mSup + h - (h * v) / tope
        g.push(`<line x1="${mIzq}" y1="${y.toFixed(1)}" x2="${W - 8}" y2="${y.toFixed(1)}" stroke="var(--linea)" stroke-width="1"/><text x="${mIzq - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--suave)">${v}</text>`)
      }
      const cada = Math.max(1, Math.ceil(I.length / 10))
      I.forEach((x, i) => {
        const bh = (h * x.commits) / tope
        if (bh > 0) g.push(`<rect x="${(mIzq + i * paso + 1).toFixed(1)}" y="${(mSup + h - bh).toFixed(1)}" width="${Math.max(1, paso - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--azul)"><title>${x.dia}: ${x.commits} commits</title></rect>`)
        if (i % cada === 0) g.push(`<text x="${(mIzq + i * paso + paso / 2).toFixed(1)}" y="${mSup + h + 16}" text-anchor="middle" font-size="11" fill="var(--suave)">${x.dia.slice(8)}-${x.dia.slice(5, 7)}</text>`)
      })
      g.push('<text x="6" y="11" font-size="11" fill="var(--suave)">commits</text>')
      const pico = d.inventario_pico
      partes.push(
        `<h3>${escapar(nombre)}Commits escritos y sin integrar al cierre de cada día</h3>`,
        `<div class="tabla-ancha"><svg viewBox="0 0 ${W} ${alto}" width="100%" role="img" aria-label="Commits escritos y sin llegar a la rama principal al cierre de cada día" style="display:block;min-width:640px;background:#fff;border:1px solid var(--linea);border-radius:8px">${g.join('')}</svg></div>`,
        `<p class="ley">Por qué este gráfico: muestra si una acumulación como la de hoy es un caso aislado o se repite. Barra: commits ya escritos al final de ese día que aún no habían llegado a <code>${escapar(r.origen.rama)}</code> (de los que acabaron llegando). Unidad: commits. Ventana: del ${I[0].dia} al ${I[I.length - 1].dia} (n = ${plural(I.length, 'día', 'días')}). Cifras: máximo de ${plural(pico.commits, 'commit', 'commits')} el ${pico.dia}; ${I.filter(x => x.commits > 10).length} de ${I.length} días con más de 10. Fuente: reflog de ${escapar(r.origen.rama)} en este clon, ${calculado}.</p>`,
      )
    }
    const y = d.proyeccion
    if (!y.medida) partes.push(`<p>${escapar(nombre)}Proyección de la cola: ${nm(`proyección de la cola de ${r.nombre}`, `no se puede proyectar: ${y.motivo}`)}</p>`)
    else if (!y.estable) partes.push(`<p>${escapar(nombre)}Proyección de la cola: <strong>no se puede proyectar.</strong> La cola a 4 semanas saldría entre ${y.a_4_semanas.p10} y ${y.a_4_semanas.p90} issues (P10–P90), pero al quitar una sola semana el centro se mueve de ${y.rango_al_quitar_una.min} a ${y.rango_al_quitar_una.max}: no es estable. <span class="pie">n = ${y.semanas_usadas} semanas completas · cola de hoy: ${y.cola_inicial} issues · ${calculado}.</span></p>`)
    else partes.push(`<p>${escapar(nombre)}Cola a 4 semanas: entre ${y.a_4_semanas.p10} y ${y.a_4_semanas.p90} issues (P10–P90), centro ${y.a_4_semanas.p50}. Es un rango, no una fecha. <span class="pie">n = ${y.semanas_usadas} semanas completas remuestreadas · cola de hoy: ${y.cola_inicial} issues · al quitar una semana el centro queda entre ${y.rango_al_quitar_una.min} y ${y.rango_al_quitar_una.max} · ${calculado}.</span></p>`)
  }
  if (!validos.length) partes.push(`<p>${nm('flujo', 'no hay repositorios')}</p>`)

  // 5 · Quién está en qué.
  partes.push('<h2>Quién está en qué</h2>')
  if (!n) partes.push('<div class="nota">0 repositorios que medir: instala con <code>instalar.mjs</code> o pasa <code>--raiz</code>.</div>')
  for (const r of repositorios) partes.push(r.error ? `<div class="panel"><h3>${escapar(r.nombre)}</h3><p>${nm(`el repositorio ${r.nombre}`, r.error)}</p></div>` : panelDeRepositorio(r))

  // 6 · Producción.
  partes.push('<h2>Producción</h2>', '<div class="panel">')
  if (!validos.length) partes.push(`<p>${nm('producción', 'no hay repositorios')}</p>`)
  else {
    partes.push(
      tabla(
        ['Repositorio', 'Commit publicado', 'Salud', '¿Es el de la rama principal?', 'Despliegue del último commit'],
        validos.map(r => {
          const p = r.produccion
          const motivo = p.declarada ? (datos.sin_red ? 'esta foto se tomó sin red' : 'la URL de salud no respondió') : 'el repositorio no declara produccion.salud'
          const medida = p.estado === 'medida'
          const d = r.github.despliegue
          return fila([
            celda(escapar(r.nombre)),
            celda(!medida ? nm(`commit publicado en producción de ${r.nombre}`, motivo) : p.commit ? `<code>${p.commit}</code>` : 'la URL no publica un commit'),
            celda(!medida ? nm(`salud de producción de ${r.nombre}`, motivo) : p.bien ? '○ bien' : '■ <strong>con problemas o sin respuesta</strong>'),
            celda(!medida || p.coincide === null ? nm(`si producción de ${r.nombre} corre el commit de la principal`, medida ? 'la URL no publica un commit' : motivo) : p.coincide ? 'sí' : p.codigo === 'igual' ? '○ al día: entre lo desplegado y la principal no cambió código' : p.codigo === 'no comparable' ? `▲ no comparable: ${escapar(p.commit)} no está en este clon` : '■ <strong>NO</strong>: cambió código de lo que se despliega'),
            celda(d.estado === 'sin medir' ? nm(`despliegue del último commit de ${r.nombre}`, motivoDeGitHub(r)) : `${escapar({ success: '○ desplegado', pending: '● pendiente', failure: '■ FALLÓ', error: '■ FALLÓ', 'sin despliegue': '■ sin despliegue' }[d.estado] ?? d.estado)} <span class="pie">${d.commit ?? ''}</span>`),
          ])
        }),
      ),
      `<p class="pie">Ventana: foto de las ${soloHora(ahora)} · fuente: la URL de salud de cada repositorio y el estado del commit en GitHub.</p>`,
    )
  }
  partes.push('</div>')

  // 7 · Costo, al final y pequeño.
  partes.push('<h2>Costo</h2>', `<p class="pie">Costo por issue construida: ${nm('costo por issue construida', 'este guion no lee la factura ni las transcripciones; lo calcula el panel del mod dentro de una sesión')}</p>`)

  // 8 · Lo que la página no sabe.
  partes.push('<h2>Lo que esta página no sabe</h2>', `<p>Es parte del tablero, no una nota al pie: ${plural(noSabe.length, 'cosa', 'cosas')} que esta foto no pudo medir, y por qué.</p>`, '<ul>', ...noSabe.map(x => `<li><strong>${escapar(x.que)}</strong>: <span class="nm">NO MEDIDO</span>. ${escapar(x.motivo)}.</li>`), '</ul>')

  partes.push(
    '<footer>',
    '<p class="fuente">Árboles, ramas, commits, stash, remoto, empujes y migraciones: git, en sólo lectura (status sin tocar el índice, ls-remote, nunca fetch). Ficheros sin confirmar, candados e incidentes: el disco. Issues y despliegue: la API de GitHub, sólo si el repositorio declara credencial. Producción: su URL de salud. Control: lo declarado en .claude/orquestacion.json. Umbrales: se calculan una vez al día y se guardan en umbrales.json.</p>',
    `<p class="fuente">consumo-index ${VERSION} · ${datos.cada_min ? `se actualiza solo: hooks de git (commit, merge, checkout, rebase) y una tarea cada ${Number(datos.cada_min)} min` : 'generado a mano: los disparadores (hooks de git y tarea programada) no están instalados para esta carpeta'} · la página se recarga cada 30 s · privado, no se publica · sin conexión · plantilla datito:template:v1</p>`,
    '</footer>',
    '</main>',
    // El único guion de la página: lee la hora incrustada y escribe la edad de la foto. No pide ni cambia nada más.
    `<script>(function(){var s=Math.max(0,Math.round((Date.now()-${Number(ahora)})/1000));function d(s){if(s<90)return s+' s';var m=Math.round(s/60);if(m<60)return m+' min';return Math.floor(m/60)+' h '+(m%60)+' min'}document.getElementById('edad').textContent='hace '+d(s);if(s>${MIN_FOTO_VIEJA * 60}){document.getElementById('vieja').hidden=false;document.getElementById('vieja-texto').textContent='El index no se está actualizando: última foto hace '+d(s)+'.'}})()</script>`,
    '</body>',
    '</html>',
    '',
  )
  return partes.join('\n')
}

/** El index privado: la página y su JSON. `cuellos` va arriba del todo en las dos. */
export function paginaPrivada(datos) {
  return { html: pintor(datos), json: `${JSON.stringify(datos, null, 2)}\n` }
}

/** La pizarra de un repositorio: texto llano para quien no ejecuta el mod. Sin títulos de issues. */
export function pizarraDe(repo, cuellos, ahora) {
  const o = repo.origen
  const m = repo.migraciones
  const integrando = repo.arboles.filter(a => !a.principal && /integra/i.test(`${a.rama ?? ''} ${path.posix.basename(a.ruta)}`))
  const verificando = [...repo.candados.map(c => `candado de suite tomado en ${c.rama ?? c.ruta} (${c.quien}) hace ${hace(c.hace_min)}`), ...integrando.map(a => `árbol de integración abierto: ${a.rama ?? a.ruta}`)]
  const quienes = []
  for (const a of repo.arboles.filter(x => !x.efimero)) {
    const issues = a.principal ? repo.control.asignaciones.filter(x => x.trabajador === 'claude' && !x.espera).map(x => `#${x.issue}`) : a.issue === null ? [] : [`#${a.issue}`]
    if (!a.principal && a.issue === null && !a.sin_confirmar) continue
    const sucio = a.sin_confirmar ? `${a.sin_confirmar} ficheros sin confirmar (no significa parado)` : 'árbol limpio'
    quienes.push(`- ${a.principal ? 'sesión principal' : a.trabajador ?? 'sin identificar'} · rama ${a.rama ?? 'HEAD suelto'} · ${issues.length ? issues.join(', ') : 'sin issue'} · ${sucio}${a.stash ? ` · ${a.stash} en el stash` : ''}${(a.detras ?? 0) > 0 ? ` · ${a.detras} por detrás` : ''}`)
  }
  const rojas = cuellos.filter(c => c.gravedad === 'alta')
  const carpeta = m.carpeta
  const md = [
    `# Pizarra de ${repo.nombre}`,
    '',
    `Foto: ${instante(ahora)}. La escribe un guion, sin modelo. Si la foto tiene más de ${MIN_FOTO_VIEJA} minutos, no te fíes: mide tú (abajo).`,
    '',
    `- ${o.rama}: ${o.commit ?? 'sin medir'}${o.movido_por_ultima_vez ? ` · se movió aquí por última vez: ${o.movido_por_ultima_vez}` : ''} · remoto: ${o.remoto_movido === null ? 'sin medir' : o.remoto_movido ? `MOVIDO a ${o.remoto}; tráelo antes de empujar` : 'igual'}`,
    `- Sin integrar: ${repo.integracion.medido ? `${repo.integracion.sin_integrar.total} commits escritos y sin llegar a ${o.rama} (${repo.integracion.sin_integrar.de_hoy} de hoy); ${repo.integracion.empujes_hoy} empujes hoy` : 'NO MEDIDO (no hay rama principal remota)'}`,
    `- Verificando o integrando: ${verificando.length ? verificando.join('; ') : 'nadie a la vista'}`,
    ...(m.existe
      ? [
          `- Migraciones (${carpeta}): la última en ${o.rama} es ${m.ultimo_en_principal ?? 'ninguna'}.`,
          `  Tomadas o reservadas fuera de ${o.rama}${m.reservas.declaradas ? '' : ' (el repositorio no declara reservas)'}: ${m.reservas.tabla.length ? m.reservas.tabla.map(t => `${t.numero} (${t.issue === null ? 'sin issue' : `#${t.issue}`}; ${t.usada_en.length ? `usada en ${t.usada_en.join(', ')}` : 'sin fichero'}; ${t.estado})`).join(' · ') : 'ninguna'}`,
          `  >>> SIGUIENTE NÚMERO LIBRE, MEDIDO: ${m.proximo_libre}${m.difiere_del_declarado ? ` · OJO: el declarado en orquestacion.json dice ${m.reservas.siguiente_libre_declarado} y NO COINCIDE; vale el medido` : m.reservas.siguiente_libre_declarado ? ' (coincide con el declarado)' : ''} <<<`,
        ]
      : [`- Migraciones: este repositorio no tiene ${carpeta}`]),
    `- Fuera: ${repo.control.fuera.length ? repo.control.fuera.join(', ') : 'nadie'}`,
    '',
    'Quién está en qué:',
    ...(quienes.length ? quienes : ['- nadie a la vista']),
    '',
    `Alertas rojas (${rojas.length}):`,
    ...(rojas.length ? rojas.map(c => `- ${c.que}`) : ['- ninguna']),
    '',
    'Mídelo tú antes de empujar o de numerar una migración (las dos órdenes sólo leen):',
    `    git ls-remote origin refs/heads/${o.rama.replace(/^origin\//, '')}    # si no es lo que da «git rev-parse ${o.rama}», el remoto se movió`,
    `    git log --all --not ${o.rama} --diff-filter=A --name-only --format= -- ${carpeta}    # migraciones ya tomadas fuera de ${o.rama}`,
    '',
  ].join('\n')
  const json = {
    foto: instante(ahora),
    foto_ms: ahora,
    repositorio: repo.nombre,
    origen: { rama: o.rama, commit: o.commit, movido_por_ultima_vez: o.movido_por_ultima_vez, remoto: o.remoto, remoto_movido: o.remoto_movido },
    verificando_o_integrando: verificando,
    migraciones: { carpeta, ultimo_en_principal: m.ultimo_en_principal, tabla: m.reservas.tabla.map(t => ({ numero: t.numero, issue: t.issue, usada_en: t.usada_en, estado: t.estado })), siguiente_libre_medido: m.proximo_libre, siguiente_libre_declarado: m.reservas.siguiente_libre_declarado, difiere_del_declarado: m.difiere_del_declarado },
    fuera: repo.control.fuera,
    trabajadores: repo.arboles.filter(x => !x.efimero).map(a => ({ trabajador: a.principal ? 'sesión principal' : a.trabajador, rama: a.rama, issue: a.issue, sin_confirmar: a.sin_confirmar, stash: a.stash, detras: a.detras })),
    alertas_rojas: rojas.map(c => c.que),
  }
  return { md, json: `${JSON.stringify(json, null, 2)}\n` }
}

// ── Disco ───────────────────────────────────────────────────────────────────────────────────────────

/** Escritura atómica: fichero temporal en la misma carpeta y renombrar. En Windows un lector puede retener el destino un instante. */
export async function escribir(ruta, texto) {
  const temporal = `${ruta}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(temporal, texto, 'utf8')
  for (let intento = 0; ; intento++) {
    try {
      await fsp.rename(temporal, ruta)
      return
    } catch (exc) {
      if (intento >= 5) {
        await fsp.rm(temporal, { force: true })
        throw exc
      }
      await new Promise(r => setTimeout(r, 40 * (intento + 1)))
    }
  }
}

/** Candado de corrida: crear con `wx` falla si ya existe. Uno más viejo de dos minutos es de una corrida muerta. */
export function tomarCandado(ruta, ahora = Date.now()) {
  for (let intento = 0; intento < 2; intento++) {
    try {
      fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, desde: new Date(ahora).toISOString() }), { flag: 'wx' })
      return true
    } catch {
      try {
        if (Date.now() - fs.statSync(ruta).mtimeMs < CANDADO_VIEJO_MS) return false
        fs.rmSync(ruta, { force: true })
      } catch {
        // Lo soltó otra corrida entre medias: se intenta otra vez.
      }
    }
  }
  return false
}

/**
 * Dónde se escribe si no se dice. La copia instalada escribe en su propia carpeta (la que tiene al lado su
 * repositorios.json): así un hook o una tarea nunca escriben en otro sitio que donde se instalaron.
 */
export function carpetaPorDefecto() {
  const propia = path.dirname(fileURLToPath(import.meta.url))
  if (fs.existsSync(path.join(propia, 'repositorios.json'))) return barras(propia)
  return barras(path.join(os.homedir(), '.claude', 'consumo-index'))
}

function leerRepositorios(salida) {
  const d = leerJson(path.join(salida, 'repositorios.json'))
  return Array.isArray(d?.repositorios) ? d.repositorios.filter(r => r && typeof r.raiz === 'string') : []
}

/**
 * Una corrida entera: mide, decide los cuellos y escribe. `opciones`: { raices, salida, sinRed, sinPizarra,
 * pedir, ahora }. Devuelve el resumen; quien llama decide qué imprime.
 */
export async function generar(opciones = {}) {
  const inicio = Date.now()
  const ahora = opciones.ahora ?? inicio
  const salida = barras(opciones.salida ?? carpetaPorDefecto())
  await fsp.mkdir(salida, { recursive: true })
  const lista = leerJson(path.join(salida, 'repositorios.json'))
  const declarados = leerRepositorios(salida)
  const mismo = (a, b) => barras(path.resolve(a)).toLowerCase() === barras(path.resolve(b)).toLowerCase()
  const entradas = opciones.raices?.length ? opciones.raices.map(raiz => ({ ...(declarados.find(d => mismo(d.raiz, raiz)) ?? {}), ...(opciones.config ?? {}), raiz: barras(path.resolve(raiz)) })) : declarados

  const antes = leerJson(path.join(salida, 'vistos.json')) ?? {}
  const vistos = { antes, ahora: {} }
  // Los umbrales se calculan una vez al día y se guardan: el refresco sólo compara.
  const umbrales = leerJson(path.join(salida, 'umbrales.json')) ?? {}
  const umbralesAntes = JSON.stringify(umbrales)
  const medidos = []
  for (const e of entradas) medidos.push(await medirRepositorio(e, { ahora, sinRed: opciones.sinRed, pedir: opciones.pedir, umbrales, salida }))
  if (JSON.stringify(umbrales) !== umbralesAntes) await escribir(path.join(salida, 'umbrales.json'), `${JSON.stringify(umbrales, null, 2)}\n`)

  const porRepo = medidos.map(m => ordenar(cuellosDe(m, ahora, vistos)))
  const cuellos = ordenar(porRepo.flat())
  const datos = {
    // Arriba del todo, a propósito: es lo primero que lee quien abre el fichero.
    cuellos: cuellos.map(({ gravedad, tipo, que, desde, desde_ms, repositorio, datos }) => ({ gravedad, tipo, que, desde, desde_ms, repositorio, datos })),
    foto: instante(ahora),
    foto_ms: ahora,
    duracion_ms: 0,
    version: VERSION,
    sin_red: opciones.sinRed === true,
    cada_min: Number.isInteger(lista?.cada_min) ? lista.cada_min : null,
    repositorios: medidos.map(m => m.repo),
  }
  datos.duracion_ms = Date.now() - inicio
  const diario = leerJson(path.join(salida, 'diario.json'))
  datos.diario_calculado_ms = typeof diario?.calculado_ms === 'number' ? diario.calculado_ms : null
  datos.decisiones = diario?.decisiones ?? null
  for (const repo of datos.repositorios) repo.diario = (repo.raiz && diario?.repositorios?.[repo.raiz.toLowerCase()]) || null
  const privada = paginaPrivada(datos)
  await escribir(path.join(salida, 'index.json'), privada.json)
  await escribir(path.join(salida, 'index.html'), privada.html)
  await escribir(path.join(salida, 'vistos.json'), `${JSON.stringify(vistos.ahora, null, 2)}\n`)

  const pizarras = []
  for (const [i, m] of medidos.entries()) {
    if (m.salud) {
      // A la ficha pública sólo llega lo que la URL respondió, y la hora.
      const publica = fichaDeProduccion({ commit: m.salud.commit, bien: m.salud.bien, cuando: ahora })
      const base = path.join(salida, `produccion-${nombreDeArchivo(m.repo.nombre)}`)
      await escribir(`${base}.html`, publica.html)
      await escribir(`${base}.json`, publica.json)
    }
    if (!opciones.sinPizarra && m.comun && !m.repo.error) {
      try {
        const carpeta = path.join(m.comun, 'consumo')
        await fsp.mkdir(carpeta, { recursive: true })
        const p = pizarraDe(m.repo, porRepo[i], ahora)
        await escribir(path.join(carpeta, 'PIZARRA.md'), p.md)
        await escribir(path.join(carpeta, 'pizarra.json'), p.json)
        pizarras.push(barras(path.join(carpeta, 'PIZARRA.md')))
      } catch {
        // Sin permiso para escribir ahí no hay pizarra; el index vale igual.
      }
    }
  }
  const diarioViejo = datos.diario_calculado_ms === null || ahora - datos.diario_calculado_ms > HORAS_DIARIO * 60 * MIN
  return { salida, diario_pendiente: diarioViejo && opciones.sinRed !== true && entradas.some(e => e.credencial), index: `${salida}/index.html`, cuellos: datos.cuellos, arboles: medidos.reduce((n, m) => n + (m.repo.arboles_vistos ?? 0), 0), repositorios: medidos.length, duracion_ms: Date.now() - inicio, pizarras }
}

export function leerArgumentos(argv) {
  const o = { raices: [], salida: null, sinRed: false, sinPizarra: false, diario: false, ayuda: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--raiz') o.raices.push(argv[++i])
    else if (a === '--salida') o.salida = argv[++i]
    else if (a === '--sin-red') o.sinRed = true
    else if (a === '--sin-pizarra') o.sinPizarra = true
    else if (a === '--diario') o.diario = true
    else if (a === '--ayuda' || a === '-h' || a === '--help') o.ayuda = true
    else throw new Error(`argumento desconocido: ${a}`)
  }
  if (o.raices.some(r => !r) || o.salida === undefined) throw new Error('falta el valor de un argumento')
  return o
}

/** La orden entera, con su candado. Código de salida: 0 también cuando otra corrida ya está en marcha. */
export async function principal(argv, extra = {}) {
  let o
  try {
    o = leerArgumentos(argv)
  } catch (exc) {
    console.error(`${exc.message}\nUso: node indice.mjs [--raiz <repo>]... [--salida <carpeta>] [--sin-red] [--sin-pizarra] [--diario]`)
    return 2
  }
  if (o.ayuda) {
    console.log('Uso: node indice.mjs [--raiz <repo>]... [--salida <carpeta>] [--sin-red] [--sin-pizarra]')
    return 0
  }
  const salida = barras(o.salida ?? carpetaPorDefecto())
  fs.mkdirSync(salida, { recursive: true })
  const guionDiario = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diario.mjs')
  if (o.diario) {
    // El cálculo diario, a mano: lo mismo que se lanza solo cuando el que hay tiene más de HORAS_DIARIO horas.
    const { principalDiario } = await import(pathToFileURL(guionDiario).href)
    return principalDiario([...o.raices.flatMap(r => ['--raiz', r]), '--salida', salida], extra)
  }
  const candado = path.join(salida, '.indice.lock')
  const pendiente = path.join(salida, '.indice.pendiente')
  if (!tomarCandado(candado)) {
    // Otra corrida está midiendo: se le deja dicho que algo cambió mientras medía, y ésta no hace nada.
    try {
      fs.writeFileSync(pendiente, '')
    } catch {
      // sin aviso; la tarea programada vuelve a pasar
    }
    console.log('index: ya hay una corrida en marcha; ésta no hace nada')
    return 0
  }
  try {
    let r
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      fs.rmSync(pendiente, { force: true })
      r = await generar({ ...extra, raices: o.raices, salida, sinRed: o.sinRed, sinPizarra: o.sinPizarra })
      if (!fs.existsSync(pendiente)) break
    }
    // El cálculo diario va aparte, en segundo plano y sin retrasar el refresco: esta foto usa el que haya.
    // Como mucho un intento cada media hora, para que un fallo (sin red, credencial rechazada) no lo relance en cada foto.
    const intento = path.join(salida, '.diario.intento')
    let reciente = false
    try {
      reciente = Date.now() - fs.statSync(intento).mtimeMs < 30 * MIN
    } catch {
      reciente = false
    }
    if (r.diario_pendiente && !reciente && fs.existsSync(guionDiario)) {
      fs.writeFileSync(intento, '')
      const argumentos = [guionDiario, ...o.raices.flatMap(x => ['--raiz', x]), '--salida', salida]
      if (extra.lanzar) extra.lanzar(argumentos)
      else spawn(process.execPath, argumentos, { detached: true, stdio: 'ignore', windowsHide: true, env: entornoDeGit() }).unref()
    }
    if (!r.repositorios) console.log(`index: ningún repositorio que medir (usa --raiz o instala con instalar.mjs) · ${r.index}`)
    else console.log(`index: ${r.cuellos.length} cuellos de botella · ${r.arboles} árboles en ${r.repositorios} ${r.repositorios === 1 ? 'repositorio' : 'repositorios'} · ${r.duracion_ms} ms · ${r.index}`)
    return 0
  } catch (exc) {
    console.error(`index: no se pudo generar (${String(exc?.message ?? exc).slice(0, 200)})`)
    return 1
  } finally {
    fs.rmSync(candado, { force: true })
  }
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

// Sin «await» en el nivel superior: «--diario» importa diario.mjs, que importa este módulo, y un await aquí los dejaría esperándose.
if (esElPrincipal()) principal(process.argv.slice(2)).then(codigo => {
  process.exitCode = codigo
})
