#!/usr/bin/env node
// El cálculo diario del index: lo que no cabe en un refresco. Node estándar, sin modelo.
//
//   node diario.mjs [--raiz <repo>]... [--salida <carpeta>]      (o: node indice.mjs --diario)
//
// Lee TODAS las issues del repositorio (sin títulos: número, fechas, estado y etiquetas) con la credencial que
// el repositorio declara, y el historial de git en sólo lectura, y guarda en <salida>/diario.json: la tabla
// semana a semana, los cierres en bloque, el tiempo de entrega de las issues construidas, las hechas sin ningún
// commit que las nombre y los commits sin integrar al cierre de cada día. El refresco (indice.mjs) sólo lee ese
// fichero y dice su fecha. Sin credencial declarada no hay cálculo: esas secciones siguen en NO MEDIDO.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HUECO_BLOQUE, LIMITE_HTTP_MS, MINIMO_BLOQUE, VERSION, barras, carpetaPorDefecto, configurar, cuantil, diaLocal, escribir, git, instante, leerCredencial, umbralDeHuecos } from './indice.mjs'

export const SEMILLA = 20261008
export const SEMANAS_PARA_PROYECTAR = 8
// Ráfaga: cierres consecutivos separados como mucho HUECO_BLOQUE minutos. Bloque: una ráfaga de MINIMO_BLOQUE o más.
/** n mínimo para publicar cada resumen: por debajo se dice «insuficiente», no se da la cifra. */
export const N_MINIMO = Object.freeze({ p50: 10, p85: 20, p95: 40 })
const MIN = 60_000
const DIA = 24 * 60 * MIN
const TRAMOS = [[0, 1 / 24, '< 1 h'], [1 / 24, 1, '1 h – 1 d'], [1, 3, '1 – 3 d'], [3, 7, '3 – 7 d'], [7, 14, '7 – 14 d'], [14, 21, '14 – 21 d'], [21, Infinity, '> 21 d']]

const sinAcentos = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const medianoche = ms => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}
/** El lunes (hora local) de la semana de ese instante. Las semanas van de lunes a domingo. */
export function lunesLocal(ms) {
  const d = medianoche(ms)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/** Un generador con semilla (mulberry32): la simulación da lo mismo cada vez. No es el de Python. */
export function generador(semilla) {
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** La cola a `semanas` vista, remuestreando con reemplazo las semanas observadas: [{ altas, cierres }]. */
export function simularCola(pares, colaInicial, semanas, corridas, azar) {
  const finales = []
  for (let c = 0; c < corridas; c++) {
    let q = colaInicial
    for (let s = 0; s < semanas; s++) {
      const p = pares[Math.floor(azar() * pares.length)]
      q = Math.max(0, q + p.altas - p.cierres)
    }
    finales.push(q)
  }
  return { p10: Math.round(cuantil(finales, 0.1)), p50: Math.round(cuantil(finales, 0.5)), p90: Math.round(cuantil(finales, 0.9)) }
}

/**
 * Todo el cálculo, sin entrada ni salida. `issues`: [{ number, createdAt, closedAt, state, stateReason, labels }]
 * (labels: nombres). `commits`: [{ sha, ms, issues: [n] }] de todas las ramas. `llegada`: Map sha → ms en que llegó
 * a la rama principal remota. `entradas`: el reflog de esa rama, [{ ms, empuje }]. Ningún título entra aquí.
 */
export function calcularDiario({ issues, commits, llegada, entradas, ahora }) {
  const porIssue = new Map()
  for (const c of commits) for (const n of c.issues) (porIssue.get(n) ?? porIssue.set(n, []).get(n)).push(c.ms)
  const filas = issues.map(i => {
    const etiquetas = (i.labels ?? []).map(sinAcentos)
    const creada = Date.parse(i.createdAt)
    const cerrada = i.state !== 'OPEN' && i.closedAt ? Date.parse(i.closedAt) : null
    const antes = (porIssue.get(i.number) ?? []).filter(ms => cerrada === null || ms <= cerrada)
    const descartada = cerrada !== null && i.stateReason === 'NOT_PLANNED'
    const epica = etiquetas.some(e => /^(type:)?(epic|epica)$/.test(e))
    return { n: i.number, creada, cerrada, descartada, epica, clase: cerrada === null ? null : descartada ? 'descartada' : epica ? 'épica' : antes.length ? 'construida' : 'sin commit', bloque: false }
  })
  if (!filas.length) return { medido: false, motivo: 'el repositorio no tiene issues' }
  const cerradas = filas.filter(f => f.cerrada !== null).sort((a, b) => a.cerrada - b.cerrada)
  const abiertas = filas.filter(f => f.cerrada === null)

  // Cierres en bloque.
  const rafagas = []
  for (const f of cerradas) {
    const ultima = rafagas[rafagas.length - 1]
    if (ultima && f.cerrada - ultima[ultima.length - 1].cerrada <= HUECO_BLOQUE * MIN) ultima.push(f)
    else rafagas.push([f])
  }
  const bloques = rafagas.filter(r => r.length >= MINIMO_BLOQUE)
  for (const r of bloques) for (const f of r) f.bloque = true

  // Semana a semana, en hora local. La semana en curso va marcada y con sus días transcurridos.
  const semanas = []
  for (let d = lunesLocal(Math.min(...filas.map(f => f.creada))); d.getTime() <= ahora; ) {
    const ini = d.getTime()
    const sig = new Date(d)
    sig.setDate(sig.getDate() + 7)
    const fin = sig.getTime()
    const cs = cerradas.filter(f => ini <= f.cerrada && f.cerrada < fin)
    const altas = filas.filter(f => ini <= f.creada && f.creada < fin).length
    const descartadas = cs.filter(f => f.descartada).length
    const enBloque = cs.filter(f => f.bloque).length
    semanas.push({
      lunes: diaLocal(ini),
      completa: fin <= ahora,
      dias_transcurridos: Math.min(7, Math.round(((ahora - ini) / DIA) * 10) / 10),
      altas,
      cierres: cs.length,
      hechas: cs.length - descartadas,
      descartadas,
      construidas: cs.filter(f => f.clase === 'construida').length,
      sin_commit: cs.filter(f => f.clase === 'sin commit').length,
      epicas: cs.filter(f => f.clase === 'épica').length,
      en_bloque: enBloque,
      fuera_de_bloque: cs.length - enBloque,
      neto: altas - cs.length,
      abiertas_al_final: filas.filter(f => f.creada < fin).length - cerradas.filter(f => f.cerrada < fin).length,
    })
    d = sig
  }
  const completas = semanas.filter(s => s.completa)

  // Tiempo de entrega (alta → cierre) de las construidas, en días.
  const construidas = cerradas.filter(f => f.clase === 'construida')
  const dias = construidas.map(f => (f.cerrada - f.creada) / DIA)
  const con = (q, minimo) => (dias.length >= minimo ? cuantil(dias, q) : null)
  const entrega = {
    n: dias.length,
    p50_dias: con(0.5, N_MINIMO.p50),
    p85_dias: con(0.85, N_MINIMO.p85),
    p95_dias: con(0.95, N_MINIMO.p95),
    menos_de_1_hora: dias.filter(x => x < 1 / 24).length,
    histograma: TRAMOS.map(([a, b, tramo]) => ({ tramo, n: dias.filter(x => a <= x && x < b).length })),
    desde: construidas.length ? diaLocal(Math.min(...construidas.map(f => f.cerrada))) : null,
    hasta: construidas.length ? diaLocal(Math.max(...construidas.map(f => f.cerrada))) : null,
  }

  // Commits escritos y sin llegar a la rama principal al cierre de cada día (de los que acabaron llegando).
  const inicio = Math.min(...filas.map(f => f.creada))
  const horaDe = new Map(commits.map(c => [c.sha, c.ms]))
  const pares = []
  for (const [sha, llego] of llegada) {
    const escrito = horaDe.get(sha)
    if (escrito !== undefined && escrito >= inicio) pares.push([escrito, llego])
  }
  const inventario = []
  for (let d = medianoche(inicio); d.getTime() <= ahora; ) {
    const sig = new Date(d)
    sig.setDate(sig.getDate() + 1)
    const fin = Math.min(sig.getTime(), ahora)
    inventario.push({ dia: diaLocal(d.getTime()), commits: pares.filter(([escrito, llego]) => escrito <= fin && fin < llego).length })
    d = sig
  }
  const pico = inventario.reduce((m, x) => (x.commits > (m?.commits ?? -1) ? x : m), null)

  // Proyección: sólo con semanas completas suficientes, y sólo si no cambia de rango al quitar una semana.
  const cola = abiertas.filter(f => !f.epica).length
  let proyeccion = { medida: false, motivo: `hay ${completas.length} ${completas.length === 1 ? 'semana completa' : 'semanas completas'} y hacen falta ${SEMANAS_PARA_PROYECTAR}` }
  if (completas.length >= SEMANAS_PARA_PROYECTAR) {
    const azar = generador(SEMILLA)
    const observadas = completas.map(s => ({ altas: s.altas, cierres: s.cierres }))
    const todas = simularCola(observadas, cola, 4, 10_000, azar)
    const quitando = observadas.map((_, i) => simularCola(observadas.filter((__, j) => j !== i), cola, 4, 2000, azar))
    const estable = quitando.every(x => x.p50 >= todas.p10 && x.p50 <= todas.p90)
    proyeccion = { medida: true, cola_inicial: cola, semanas_usadas: completas.length, a_4_semanas: todas, estable, rango_al_quitar_una: { min: Math.min(...quitando.map(x => x.p50)), max: Math.max(...quitando.map(x => x.p50)) }, semilla: SEMILLA }
  }

  return {
    medido: true,
    universo: {
      issues: filas.length,
      abiertas: abiertas.length,
      cerradas: cerradas.length,
      hechas: cerradas.filter(f => !f.descartada).length,
      descartadas: cerradas.filter(f => f.descartada).length,
      primera_alta: diaLocal(inicio),
      commits: commits.length,
      commits_que_nombran_issue: commits.filter(c => c.issues.length).length,
    },
    semanas,
    semanas_completas: completas.length,
    bloques: {
      bloques: bloques.length,
      cierres_en_bloque: bloques.reduce((s, r) => s + r.length, 0),
      cierres: cerradas.length,
      detalle: bloques.map(r => ({ dia: diaLocal(r[0].cerrada), n: r.length, duracion_min: Math.round(((r[r.length - 1].cerrada - r[0].cerrada) / MIN) * 10) / 10 })).sort((a, b) => b.n - a.n),
    },
    entrega,
    // «Hechas» que ningún commit nombra antes de cerrarse: no se sabe con qué se construyeron. Las épicas no cuentan.
    hechas_sin_commit: { n: cerradas.filter(f => f.clase === 'sin commit').length, de: cerradas.filter(f => f.clase === 'sin commit' || f.clase === 'construida').length },
    inventario,
    inventario_pico: pico,
    umbral_huecos: umbralDeHuecos(entradas, ahora),
    proyeccion,
  }
}

// ── Extracción ──────────────────────────────────────────────────────────────────────────────────────

const CONSULTA = 'query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){issues(first:100,after:$c,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor} nodes{number createdAt closedAt state stateReason labels(first:30){nodes{name}}}}}}'

async function pedirConCalma(url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(LIMITE_HTTP_MS * 6) })
    return { status: r.status, texto: await r.text() }
  } catch {
    return { status: 0, texto: '' }
  }
}

/** Todas las issues, sin títulos. Devuelve { issues } o { error } (una frase sin la credencial dentro). */
export async function leerIssues(repoGh, valor, pedir = pedirConCalma) {
  const [duena, nombre] = repoGh.split('/')
  const issues = []
  let cursor = null
  for (let pagina = 0; pagina < 60; pagina++) {
    const r = await pedir('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${valor}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'consumo-index' },
      body: JSON.stringify({ query: CONSULTA, variables: { o: duena, n: nombre, c: cursor } }),
      redirect: 'error',
    })
    if (r.status === 401) return { error: 'GitHub rechazó la credencial (401)' }
    if (r.status !== 200) return { error: r.status ? `GitHub respondió ${Number(r.status)}` : 'GitHub no respondió' }
    let d
    try {
      d = JSON.parse(r.texto)?.data?.repository?.issues
    } catch {
      d = null
    }
    if (!d || !Array.isArray(d.nodes)) return { error: 'GitHub no devolvió las issues' }
    for (const n of d.nodes) issues.push({ number: n.number, createdAt: n.createdAt, closedAt: n.closedAt, state: n.state, stateReason: n.stateReason, labels: (n.labels?.nodes ?? []).map(e => String(e?.name ?? '')) })
    if (!d.pageInfo?.hasNextPage) return { issues }
    cursor = d.pageInfo.endCursor
  }
  return { issues }
}

/** El historial, en sólo lectura: los commits de todas las ramas con las issues que nombran, y cuándo llegó cada uno a la principal remota. */
export async function leerGit(raiz, principal) {
  const ref = `refs/remotes/origin/${principal}`
  const [log, reflog] = await Promise.all([git(raiz, ['log', '--all', '--format=%H%x00%ct%x00%s%x00%b%x1e'], 120_000), git(raiz, ['reflog', 'show', ref, '--format=%H%x00%ct%x00%gs'])])
  const commits = []
  for (const bloque of log.ok ? log.out.split('\x1e') : []) {
    const [sha, ct, asunto, cuerpo] = bloque.replace(/^\s+/, '').split('\0')
    if (!sha || !Number(ct)) continue
    commits.push({ sha, ms: Number(ct) * 1000, issues: [...new Set([...`${asunto ?? ''}\n${cuerpo ?? ''}`.matchAll(/#(\d+)\b/g)].map(m => Number(m[1])))] })
  }
  const entradas = []
  for (const linea of reflog.ok ? reflog.out.split(/\r?\n/) : []) {
    const [sha, ct, asunto] = linea.split('\0')
    if (Number(ct)) entradas.push({ sha, ms: Number(ct) * 1000, empuje: (asunto ?? '').startsWith('update by push') })
  }
  // Cada entrada del reflog trae los commits que no estaban en la anterior: ésa es su hora de llegada.
  const cronologico = [...entradas].reverse()
  const llegada = new Map()
  let siguiente = 0
  const tandas = Array.from({ length: 12 }, async () => {
    while (siguiente < cronologico.length) {
      const i = siguiente++
      if (i === 0) continue
      const l = await git(raiz, ['rev-list', cronologico[i].sha, `^${cronologico[i - 1].sha}`], 60_000)
      for (const sha of l.ok ? l.out.split(/\r?\n/) : []) if (sha && !llegada.has(sha)) llegada.set(sha, cronologico[i].ms)
    }
  })
  await Promise.all(tandas)
  return { commits, entradas, llegada }
}

/** El cálculo de un repositorio, con su extracción. `deps`: { pedir, ahora }. Nunca lanza. */
export async function diarioDe(entrada, deps = {}) {
  const ahora = deps.ahora ?? Date.now()
  const raiz = barras(entrada.raiz)
  let declarado = null
  try {
    declarado = JSON.parse(fs.readFileSync(path.join(raiz, '.claude', 'orquestacion.json'), 'utf8'))
  } catch {
    declarado = null
  }
  const cfg = configurar(entrada, declarado)
  if (!cfg.credencial) return { medido: false, motivo: 'el repositorio no declara credencial de GitHub' }
  const valor = leerCredencial(raiz, cfg.credencial)
  if (!valor) return { medido: false, motivo: 'la variable de la credencial no está en el fichero declarado' }
  let repoGh = cfg.repo
  if (!repoGh) {
    const remoto = await git(raiz, ['remote', 'get-url', 'origin'])
    repoGh = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoto.out.trim())?.slice(1, 3).join('/') ?? null
  }
  if (!repoGh) return { medido: false, motivo: 'el remoto no es de GitHub' }
  const leidas = await leerIssues(repoGh, valor, deps.pedir)
  if (leidas.error) return { medido: false, motivo: leidas.error }
  const { commits, entradas, llegada } = await leerGit(raiz, cfg.principal)
  try {
    return calcularDiario({ issues: leidas.issues, commits, llegada, entradas, ahora })
  } catch (exc) {
    return { medido: false, motivo: `el cálculo falló (${String(exc?.message ?? exc).slice(0, 120)})` }
  }
}

/** La orden entera. Código 0 también si otra corrida del cálculo diario ya está en marcha. */
export async function principalDiario(argv, deps = {}) {
  const raices = []
  let salida = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--raiz') raices.push(argv[++i])
    else if (argv[i] === '--salida') salida = argv[++i]
    else if (argv[i] !== '--diario' && argv[i] !== '--sin-pizarra') {
      console.error(`argumento desconocido: ${argv[i]}\nUso: node diario.mjs [--raiz <repo>]... [--salida <carpeta>]`)
      return 2
    }
  }
  salida = barras(salida ?? carpetaPorDefecto())
  fs.mkdirSync(salida, { recursive: true })
  const candado = path.join(salida, '.diario.lock')
  // Un cálculo diario puede tardar: el candado de otra corrida vale veinte minutos; después es de una corrida muerta.
  try {
    if (Date.now() - fs.statSync(candado).mtimeMs > 20 * MIN) fs.rmSync(candado, { force: true })
  } catch {
    // no hay candado
  }
  try {
    fs.writeFileSync(candado, String(process.pid), { flag: 'wx' })
  } catch {
    console.log('diario: ya hay un cálculo en marcha; éste no hace nada')
    return 0
  }
  const inicio = Date.now()
  try {
    let declarados = []
    try {
      const d = JSON.parse(fs.readFileSync(path.join(salida, 'repositorios.json'), 'utf8'))
      if (Array.isArray(d?.repositorios)) declarados = d.repositorios.filter(r => r && typeof r.raiz === 'string')
    } catch {
      declarados = []
    }
    const mismo = (a, b) => barras(path.resolve(a)).toLowerCase() === barras(path.resolve(b)).toLowerCase()
    const entradas = raices.length ? raices.map(raiz => ({ ...(declarados.find(d => mismo(d.raiz, raiz)) ?? {}), raiz: barras(path.resolve(raiz)) })) : declarados
    const ahora = deps.ahora ?? Date.now()
    const repositorios = {}
    for (const e of entradas) repositorios[barras(e.raiz).toLowerCase()] = await diarioDe(e, { ...deps, ahora })
    await escribir(path.join(salida, 'diario.json'), `${JSON.stringify({ version: VERSION, calculado_ms: ahora, calculado: instante(ahora), duracion_ms: Date.now() - inicio, repositorios }, null, 2)}\n`)
    const medidos = Object.values(repositorios).filter(r => r.medido).length
    console.log(`diario: ${medidos} de ${entradas.length} ${entradas.length === 1 ? 'repositorio medido' : 'repositorios medidos'} · ${Date.now() - inicio} ms · ${salida}/diario.json`)
    return 0
  } catch (exc) {
    console.error(`diario: no se pudo calcular (${String(exc?.message ?? exc).slice(0, 200)})`)
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

if (esElPrincipal()) process.exitCode = await principalDiario(process.argv.slice(2))
