import { expect, mock, test } from 'claude-code/testing'

import { MOTIVO_A_MEDIAS, enrutar, pesar, tabla } from './router'
import type { Actividad, Issue } from './router'

const props = { title: 'Consumo', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const
const viewport = { columns: 160, rows: 64, isFullscreen: true }

// El tablero se dibuja en el terminal y en el escritorio sin datos: muestra sus indicadores, sus
// secciones y sus botones, y no depende de una superficie.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`el tablero de consumo se dibuja sin datos en ${surface}`, async $ => {
    const pane = await $.ui.mount({ plugin: 'consumo', surface, component: 'Pane', requestId: 'consumo', props, viewport })
    expect(await pane.find({ text: /Tanque de contexto/ })).toBeDefined()
    expect(await pane.find({ text: /Presupuesto 200 USD/ })).toBeDefined()
    expect(await pane.find({ text: /Autonomía/ })).toBeDefined()
    expect(await pane.find({ text: /Avance real/ })).toBeDefined()
    expect(await pane.find({ text: /3 · ¿Quién tiene cada issue/ })).toBeDefined()
    expect(await pane.find({ text: /Pendiente en GitHub/ })).toBeDefined()
    expect(await pane.find({ text: /Cobertura de pruebas/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /Actualizar/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /GitHub/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /Avance/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', text: /pytest/ })).toBeDefined()
  })
}

test('el presupuesto configurado se lee en el tablero', { options: { presupuestoUsd: 50 } }, async $ => {
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Presupuesto 50 USD/ })).toBeDefined()
})

// Sin medición, el avance lo dice y enseña cómo pedirla: no pinta ceros como si fueran un resultado.
test('sin medición, el avance real no inventa cifras', async $ => {
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /sin medición todavía/ })).toBeDefined()
  expect(await pane.find({ text: /repositorio por detectar/ })).toBeDefined()
})

// Con una medición (de ejemplo), el avance enseña las issues cerradas, la parte
// de la factura que se lleva el proyecto, lo que sale cada issue y avisa de la semana con consumo y sin cierres.
test('con una medición, el avance real muestra cierres, factura y la semana sin cierres', async ($, on) => {
  // La medición entra por el camino real: «/consumo avance» corre el proceso, que aquí contesta la prueba.
  // Lo que el motor de pruebas no trae lo contesta la prueba: abrir el panel, el reloj, la carpeta y el disco.
  // Cada respuesta va como { value }, que es lo que el motor acepta de un hook para estas llamadas.
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[] }) => unknown) => void
  contestar('ui.open', () => ({ value: undefined }))
  contestar('clock.now', () => ({ value: 1_780_000_000_000 }))
  contestar('session.cwd', () => ({ value: 'F:/proyecto' }))
  contestar('session.root', () => ({ value: 'F:/proyecto' }))
  contestar('fs.exists', () => ({ value: false }))
  contestar('process.run', (_$, e) =>
    (e.argv ?? []).includes('--factura')
      ? { value: { exitCode: 0, stdout: JSON.stringify(medicion), stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } },
  )
  const medicion = {
    desde: '2026-08-31',
    factura: 238,
    proyecto: {
      clave: 'f--code-acme',
      sesiones: 36,
      prompts: 562,
      llamadas: 20110,
      pct_del_total: 46.5,
      usd_factura: 110.55,
      pct_subagentes: 36.2,
      pct_relectura: 74.7,
      despertares: 73,
      despertares_vacios: 32,
      agentes: 146,
    },
    repo: { nombre: 'acme/plataforma', via: 'cuenta acme', error: '', abiertas: 72, creadas: 209, hechas: 132, descartadas: 5, usd_por_issue: 0.84 },
    semanas: [
      { lunes: '2026-09-07', creadas: 69, hechas: 16, descartadas: 4, abiertas_fin: 49, usd_factura: 20, pct_del_proyecto: 18 },
      { lunes: '2026-09-14', creadas: 22, hechas: 35, descartadas: 1, abiertas_fin: 35, usd_factura: 18, pct_del_proyecto: 16 },
      { lunes: '2026-09-21', creadas: 23, hechas: 26, descartadas: 0, abiertas_fin: 32, usd_factura: 17.7, pct_del_proyecto: 15.9 },
      { lunes: '2026-09-28', creadas: 74, hechas: 55, descartadas: 0, abiertas_fin: 51, usd_factura: 44.4, pct_del_proyecto: 40.2 },
      { lunes: '2026-10-05', creadas: 21, hechas: 0, descartadas: 0, abiertas_fin: 72, usd_factura: 10.93, pct_del_proyecto: 9.9 },
    ],
    reparto: [{ nombre: 'acme', pct: 46.5, usd: 110.55 }],
  }
  const respuesta = await $.command.run({ command: 'consumo', args: 'avance' } as never)
  expect(JSON.stringify(respuesta)).toContain('132 issues cerradas')
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Avance real · acme\/plataforma · desde el 31-08/ })).toBeDefined()
  expect(await pane.find({ text: /132 cerradas · 5 descartadas · 209 creadas · 72 abiertas hoy/ })).toBeDefined()
  expect(await pane.find({ text: /este proyecto ≈ 111 USD \(46\.5 %\)/ })).toBeDefined()
  expect(await pane.find({ text: /0\.84 USD por issue cerrada/ })).toBeDefined()
  expect(await pane.find({ text: /Esta semana: ≈ 11 USD de consumo y ninguna issue cerrada \(21 creadas\)/ })).toBeDefined()
  expect(await pane.find({ text: /73 despertares del bucle, 32 sin cambios/ })).toBeDefined()
})

// ── El control ──────────────────────────────────────────────────────────────────────────────────────
// «/consumo agentes» ejecuta el control por su camino real. Lo que el motor de pruebas no trae lo contesta
// la prueba: el disco (.claude/orquestacion.json), git y el envoltorio de GitHub del repositorio.
type IssueDePrueba = { number: number; title: string; labels: { name: string }[]; body: string; projectItems: unknown[] }

// El repositorio de la prueba declara su envoltorio de gh en `herramientas`, como pide el mod a cualquier
// repositorio; `extra.herramientas` lo cambia (null: no declara ninguno). `extra.existen`: rutas que existen en disco.
// `extra.vivo`: el index.json que deja el guion sin modelo, instalado en la carpeta del index de la prueba.
const GH_DE_PRUEBA = 'scripts/gh-acme.ps1'
const CARPETA_VIVO = 'C:/Users/prueba/.claude/consumo-index'
// `extra.medicion`: lo que contesta la medición de avance (si no, falla, como en una máquina sin Python).
// `extra.salud`: lo que contesta la URL de salud a curl. Lo que no es el fichero del control (el index) queda
// en `archivos()`, por ruta.
function repositorioDePrueba(
  on: unknown,
  issues: IssueDePrueba[],
  estado: Record<string, unknown>,
  extra: { medicion?: unknown; salud?: string; herramientas?: Record<string, string> | null; existen?: string[]; vivo?: unknown; candado?: string; git?: (argv: readonly string[]) => string | null } = {},
): { escrito: () => any; versionado: () => any; local: () => any; poner: (e: unknown) => void; entro: () => string; romper: () => void; archivos: () => Record<string, string>; pedidas: () => string[]; corridas: () => string[][] } {
  const otros: Record<string, string> = {}
  const urls: string[] = []
  const corridas: string[][] = []
  const herramientas = extra.herramientas === null ? undefined : extra.herramientas ?? { gh: GH_DE_PRUEBA }
  const conHerramientas = (e: unknown) => JSON.stringify(herramientas ? { ...(e as object), herramientas } : e)
  const barrasNormales = (ruta: unknown) => String(ruta).replace(/\\/g, '/')
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[]; path?: string; text?: string }) => unknown) => void
  let guardado = conHerramientas(estado)
  let delControl = ''
  const esLocal = (ruta: unknown) => /orquestacion\.local\.json$/.test(String(ruta))
  let entrado = ''
  let roto = false
  const yo = on as unknown as (evento: string, hook: ($: unknown, e: { text: string }) => unknown) => void
  yo('prompt.submit', (_$, e) => {
    entrado = e.text
    return { text: e.text }
  })
  contestar('ui.open', () => ({ value: undefined }))
  contestar('clock.now', () => ({ value: 1_780_000_000_000 }))
  contestar('session.id', () => ({ value: 'sesion' }))
  contestar('session.cwd', () => ({ value: 'F:/proyecto' }))
  contestar('session.root', () => ({ value: 'F:/proyecto' }))
  contestar('session.model', () => ({ value: 'claude-opus-5-5' }))
  contestar('fs.exists', (_$, e) => {
    if (roto) throw new Error('disco caído')
    const ruta = barrasNormales(e.path)
    if (extra.vivo !== undefined && ruta === `${CARPETA_VIVO}/indice.mjs`) return { value: true }
    if ((extra.existen ?? []).some(x => ruta.endsWith(x))) return { value: true }
    return { value: esLocal(e.path) ? delControl !== '' : /orquestacion\.json$/.test(String(e.path)) }
  })
  contestar('fs.read', (_$, e) => {
    const ruta = barrasNormales(e.path)
    if (extra.vivo !== undefined && ruta === `${CARPETA_VIVO}/index.json`) return { value: JSON.stringify(extra.vivo) }
    if (extra.candado !== undefined && (extra.existen ?? []).some(x => ruta.endsWith(x))) return { value: extra.candado }
    return { value: esLocal(e.path) ? delControl : guardado }
  })
  contestar('fs.write', (_$, e) => {
    if (esLocal(e.path)) delControl = String(e.text)
    else if (/orquestacion\.json$/.test(String(e.path))) guardado = String(e.text)
    // El motor entrega la ruta con las barras del sistema; aquí se guardan con barras normales.
    else otros[String(e.path).replace(/\\/g, '/')] = String(e.text)
    return { value: undefined }
  })
  contestar('process.run', (_$, e) => {
    const argv = e.argv ?? []
    corridas.push([...argv])
    if (argv[0] === 'git' && extra.git) {
      const dicho = extra.git(argv)
      if (dicho !== null) return { value: { exitCode: 0, stdout: dicho, stderr: '' } }
    }
    if (extra.vivo !== undefined && argv[0] === 'node' && argv[1] === '-e') return { value: { exitCode: 0, stdout: 'C:\\Users\\prueba', stderr: '' } }
    if (extra.vivo !== undefined && argv[0] === 'node' && barrasNormales(argv[1]) === `${CARPETA_VIVO}/indice.mjs`) return { value: { exitCode: 0, stdout: 'index: hecho', stderr: '' } }
    if (argv.some(a => a.endsWith(herramientas?.gh ?? GH_DE_PRUEBA)) && argv.includes('list')) return { value: { exitCode: 0, stdout: JSON.stringify(issues), stderr: '' } }
    if (argv[0] === 'git' && argv.includes('remote')) return { value: { exitCode: 0, stdout: 'https://github.com/acme/plataforma.git', stderr: '' } }
    if (argv[0] === 'git' && argv.includes('log') && argv.includes('main')) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (extra.medicion && argv.includes('--factura') && !argv.includes('--previa')) return { value: { exitCode: 0, stdout: JSON.stringify(extra.medicion), stderr: '' } }
    if (extra.salud !== undefined && argv[0] === 'curl') {
      urls.push(String(argv[argv.length - 1]))
      return { value: { exitCode: 0, stdout: extra.salud, stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } }
  })
  return {
    archivos: () => otros,
    pedidas: () => urls,
    corridas: () => corridas,
    // Lo que el control decide con los dos ficheros: lo declarado más lo suyo.
    escrito: () => ({ ...JSON.parse(guardado), ...(delControl ? JSON.parse(delControl) : {}) }),
    // Lo que la prueba declaró: el fichero versionado sin la clave `herramientas` que pone este arnés.
    versionado: () => {
      const { herramientas: _delArnes, ...declarado } = JSON.parse(guardado)
      return declarado
    },
    local: () => (delControl ? JSON.parse(delControl) : null),
    poner: e => {
      guardado = conHerramientas(e)
    },
    entro: () => entrado,
    romper: () => {
      roto = true
    },
  }
}

const issue = (number: number, title: string, etiquetas: string[] = [], body = ''): IssueDePrueba => ({ number, title, labels: etiquetas.map(name => ({ name })), body, projectItems: [{}] })

test('una Decisión no sale asignada: queda «espera al dueño» y el control sigue con la siguiente', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(325, 'Qué alcance tiene el observador', ['decision-humana']), issue(346, 'Ajustar un formulario')], { cola: [325, 346] })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('Espera al dueño: #325')
  expect(respuesta).toContain('Esta sesión tiene la #346')
  expect(repo.escrito().asignaciones['325']).toBeUndefined()
  expect(repo.escrito().asignaciones['346'].trabajador).toBe('claude')
})

test('un peso 0 no despierta a Codex: lo hace esta sesión, sin revisor y sin nombrar un modelo', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(900, 'Un literal de color pasa a token')], { cola: [900] })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  const a = repo.escrito().asignaciones['900']
  expect(a.trabajador).toBe('claude')
  expect(a.peso).toBe('XS')
  expect(a.contra).toBeUndefined()
  expect(a.modelo).toBeUndefined()
  expect(respuesta).not.toContain('Codex')
  expect(/haiku|sonnet|opus|modelo/i.test(respuesta)).toBe(false)
})

// ── El despertar ────────────────────────────────────────────────────────────────────────────────────
const BUCLE = '/loop Orquesta el cierre de todas las issues abiertas del repositorio, una por una, con su evidencia'
const despertar = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'scheduled-trigger' } } as never)
const conPasos = (pasos: { paso: string; hecho: boolean }[]) => ({
  cola: [346],
  declarado: { '346': { capas: false, pasos, criterio: 'la pantalla ya no ofrece el botón', archivos: ['apps/web/src/pagina.tsx'] } },
})

test('un despertar programado con asignación vigente lleva sólo la orden, no el prompt del bucle', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], conPasos([{ paso: 'retirar el botón', hecho: false }, { paso: 'medir en el navegador', hecho: false }]))
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('Orden: issue #346.')
  expect(repo.entro()).toContain('Siguiente paso: retirar el botón')
  expect(repo.entro()).toContain('Criterio: la pantalla ya no ofrece el botón')
  expect(repo.entro()).toContain('apps/web/src/pagina.tsx')
  expect(repo.entro()).not.toContain('Orquesta el cierre de todas las issues')
  expect(repo.entro()).not.toContain('medir en el navegador')
})

test('sin un paso que cierre algo, el despertar dice parar y no recorre el tablero', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] })
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('parar')
  expect(repo.entro()).not.toContain('Orquesta el cierre de todas las issues')
  expect(repo.entro()).not.toContain('Ajustar un formulario')
})

test('al reprogramarse el bucle, el hook vuelve a armar la orden desde el fichero', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], conPasos([{ paso: 'retirar el botón', hecho: false }, { paso: 'medir en el navegador', hecho: false }]))
  await despertar($, BUCLE)
  const primera = repo.entro()
  // Alguien marca el paso; el bucle se reprograma con la orden que recibió, no con el prompt original.
  const fichero = repo.escrito()
  fichero.declarado['346'].pasos[0].hecho = true
  repo.poner(fichero)
  await despertar($, primera)
  expect(repo.entro()).toContain('Siguiente paso: medir en el navegador')
  expect(repo.entro()).not.toContain('Siguiente paso: retirar el botón')
  // Con todos los pasos hechos, la orden es parar.
  fichero.declarado['346'].pasos[1].hecho = true
  repo.poner(fichero)
  await despertar($, repo.entro())
  expect(repo.entro()).toContain('parar')
})

test('una issue que espera al dueño también es parar, con su motivo, aunque le queden pasos', async ($, on) => {
  const estado = conPasos([{ paso: 'publicar el cierre', hecho: false }])
  ;(estado.declarado['346'] as Record<string, unknown>).espera = 'falta una credencial vigente'
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], estado)
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('parar')
  expect(repo.entro()).toContain('falta una credencial vigente')
  expect(repo.entro()).not.toContain('publicar el cierre')
})

test('si el control falla, entra el prompt original: el despertar no se pierde', async ($, on) => {
  const repo = repositorioDePrueba(on, [], { cola: [346] })
  repo.romper()
  await despertar($, BUCLE)
  expect(repo.entro()).toBe(BUCLE)
})

test('«/consumo agentes» responde en frases y no contiene la palabra «llamadas»', async ($, on) => {
  repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('El próximo despertar para')
  expect(respuesta).not.toContain('llamadas')
  expect(respuesta).not.toContain('USD')
  expect(respuesta).not.toContain('tokens')
})

test('un trabajador en fuera no recibe nada, ni como revisor de un peso L', async ($, on) => {
  const larga = 'Migración con RLS, API y pantalla web. Se acredita en el navegador.'
  const repo = repositorioDePrueba(on, [issue(342, 'Nueva tabla con su pantalla', [], larga)], { cola: [342], fuera: { codex: 'sin cuota' } })
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  const a = repo.escrito().asignaciones['342']
  expect(a.peso).toBe('L')
  expect(a.trabajador).toBe('claude')
  expect(a.contra).toBe('agy')
  const rechazo = JSON.stringify(await $.command.run({ command: 'consumo', args: 'tomar 342 codex' } as never))
  expect(rechazo).toContain('codex está fuera (sin cuota)')
})

test('el panel se lee en tres preguntas y la tercera es la orden del control', async ($, on) => {
  repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] })
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /1 · ¿Cuánto queda de presupuesto y de contexto\?/ })).toBeDefined()
  expect(await pane.find({ text: /2 · ¿Esta semana se cierra trabajo o sólo se gasta\?/ })).toBeDefined()
  expect(await pane.find({ text: /3 · ¿Quién tiene cada issue y qué va a hacer el próximo despertar\?/ })).toBeDefined()
  expect(await pane.find({ text: /Esta sesión tiene la #346/ })).toBeDefined()
})

// Un repositorio configurado a mano manda sobre el detectado y se ve en el título del avance.
test('el repositorio configurado se lee en el avance', { options: { repo: 'dueno/proyecto' } }, async $ => {
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Avance real · dueno\/proyecto/ })).toBeDefined()
})

// Una sesión recién abierta aún no tiene transcripción: el tablero lo dice, no lo pinta como un error.
// Y donde no hay pytest, la cobertura no ocupa sitio ni ofrece un botón que no mediría nada.
test('recién abierta y sin pytest: ni error de transcripción ni sección de cobertura', async ($, on) => {
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[] }) => unknown) => void
  const vacio = {
    transcripcion: 'x.jsonl',
    sin_transcripcion: true,
    ahora: 1_780_000_000,
    inicio_sesion: null,
    ultima_respuesta: null,
    total: { llamadas: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, usd: 0 },
    por_modelo: [],
    por_tarea: [],
    por_herramienta: {},
    subagentes: [],
    actual: null,
    despertador: null,
    ritmo: { cubos_usd: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ancho_cubo_min: 5, usd_ultimos_30_min: 0, usd_por_hora: 0 },
    nota_precios: '',
  }
  contestar('ui.open', () => ({ value: undefined }))
  contestar('clock.now', () => ({ value: 1_780_000_000_000 }))
  contestar('session.id', () => ({ value: 'sesion' }))
  contestar('session.cwd', () => ({ value: 'F:/proyecto' }))
  contestar('session.root', () => ({ value: 'F:/proyecto' }))
  contestar('fs.exists', () => ({ value: false }))
  contestar('process.run', (_$, e) =>
    (e.argv ?? []).includes('--sesion')
      ? { value: { exitCode: 0, stdout: JSON.stringify(vacio), stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } },
  )
  await $.command.run({ command: 'consumo', args: '' } as never)
  const respuesta = await $.command.run({ command: 'consumo', args: 'cobertura' } as never)
  expect(JSON.stringify(respuesta)).toContain('no-aplica')
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /sesión recién abierta: aún sin gasto/ })).toBeDefined()
  expect(await pane.find({ text: /el control no decide aquí|El control todavía no decidió/ })).toBeDefined()
  expect(await pane.find({ text: /no existe la transcripcion/ })).toBeUndefined()
  expect(await pane.find({ text: /Cobertura de pruebas/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /pytest/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /Avance/ })).toBeDefined()
})

// ── Regla del router: la que espera al dueño no ocupa a su trabajador ───────────────────────────────
test('con la primera issue en espera, la sesión recibe la siguiente de la cola y la orden es la de esa siguiente', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(101, 'Publicar un cierre'), issue(102, 'Ajustar un formulario'), issue(103, 'Cambiar una etiqueta')], {
    cola: [101, 102, 103],
    declarado: {
      '101': { capas: false, espera: 'falta una credencial vigente', pasos: [{ paso: 'publicar el cierre', hecho: false }] },
      '102': { capas: false, pasos: [{ paso: 'ajustar el campo del formulario', hecho: false }], criterio: 'el formulario valida el campo' },
    },
  })
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('Orden: issue #102.')
  expect(repo.entro()).toContain('Siguiente paso: ajustar el campo del formulario')
  expect(repo.entro()).not.toContain('publicar el cierre')
  expect(repo.entro()).not.toContain('parar')
  // La que espera sigue siendo suya y sigue a la vista; la tercera queda detrás de la que sí ocupa.
  const escrito = repo.escrito()
  expect(escrito.asignaciones['101'].trabajador).toBe('claude')
  expect(escrito.asignaciones['101'].estado).toBe('vigente')
  expect(escrito.asignaciones['102'].trabajador).toBe('claude')
  expect(escrito.asignaciones['103']).toBeUndefined()
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('Esta sesión tiene la #101')
  expect(respuesta).toContain('espera al dueño: falta una credencial vigente')
  expect(respuesta).toContain('Esta sesión tiene la #102')
  expect(respuesta).toContain('En cola: #103')
})

// ── El index ────────────────────────────────────────────────────────────────────────────────────────
// Se genera al medir el avance: «/consumo avance» por su camino real. La medición de la prueba trae el reparto
// con la raíz de cada proyecto y la carpeta del index, como la da el guion de avance.
const CARPETA_INDEX = 'C:/Users/prueba/.claude/consumo-index'
const medicionConReparto = (reparto: unknown[]) => ({
  version: 2,
  carpeta_index: CARPETA_INDEX,
  desde: '2026-08-31',
  factura: 238,
  proyecto: { clave: 'f--proyecto', sesiones: 3, prompts: 20, llamadas: 400, pct_del_total: 80, usd_factura: 190.4, pct_subagentes: 10, pct_relectura: 70, despertares: 4, despertares_vacios: 1, agentes: 2 },
  repo: { nombre: 'acme/plataforma', via: 'cuenta acme', error: '', abiertas: 2, creadas: 5, hechas: 3, descartadas: 0, usd_por_issue: 63.47 },
  semanas: [],
  reparto,
})
const ACME = { nombre: 'acme', pct: 80, usd: 190.4, raiz: 'F:/proyecto' }
const FOTO = '2026-05-28 20:26 UTC'

test('el index de un proyecto sin pasos dice «no hay paso» y no incluye títulos de issues', async ($, on) => {
  mock.store(on)
  const repo = repositorioDePrueba(
    on,
    [issue(7001, 'Zanahoria reconocible en el titulo'), issue(7002, 'Berenjena reconocible en la cola')],
    { cola: [7001, 7002] },
    { medicion: medicionConReparto([ACME, { nombre: 'otro', pct: 20, usd: 47.6 }]) },
  )
  // El control decide primero: el fichero queda con asignaciones y con la clasificación, que sí lleva títulos.
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  expect(JSON.stringify(repo.escrito())).toContain('Zanahoria')
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'avance' } as never))
  expect(respuesta).toContain(`Index: ${CARPETA_INDEX}/index.html`)
  const html = repo.archivos()[`${CARPETA_INDEX}/index.html`]!
  const json = repo.archivos()[`${CARPETA_INDEX}/index.json`]!
  expect(html).toContain('no hay paso')
  expect(html).toContain('#7001')
  expect(html).toContain('Esta sesión')
  expect(html).toContain('sin control')
  expect(html).not.toContain('<script')
  for (const salida of [html, json]) {
    expect(salida).not.toContain('Zanahoria')
    expect(salida).not.toContain('Berenjena')
    expect(salida).not.toContain('reconocible')
    // La cola no se repite: la segunda issue, que sólo está en cola, no sale.
    expect(salida).not.toContain('7002')
  }
  const fichas = JSON.parse(json).fichas
  expect(fichas[0]).toEqual({ nombre: 'acme', control: true, issue: 7001, quien: 'Esta sesión', paso: 'no hay paso', despertar: 'sin despertares registrados', despertar_cuando: null, foto: FOTO })
  expect(fichas[1]).toEqual({ nombre: 'otro', control: false, estado: 'sin control', foto: FOTO })
  // Sin `produccion.salud` declarado no hay ficha pública.
  expect(Object.keys(repo.archivos()).some(ruta => ruta.includes('produccion-'))).toBe(false)
})

test('la ficha pública de producción sólo tiene commit y salud, aunque el estado tenga issues, pasos, nombres y cola', async ($, on) => {
  mock.store(on)
  const repo = repositorioDePrueba(
    on,
    [issue(7001, 'Zanahoria reconocible en el titulo'), issue(7002, 'Berenjena reconocible en la cola')],
    {
      cola: [7001, 7002],
      fuera: { codex: 'sin cuota' },
      declarado: { '7001': { capas: false, pasos: [{ paso: 'retirar el remolino', hecho: false }], criterio: 'ya no gira' } },
      produccion: { salud: 'https://ejemplo.invalid/health' },
    },
    { medicion: medicionConReparto([ACME]), salud: JSON.stringify({ status: 'ok', commit: 'abcdef1234', interno: 'no debe salir' }) },
  )
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  await $.command.run({ command: 'consumo', args: 'avance' } as never)
  expect(repo.pedidas()).toEqual(['https://ejemplo.invalid/health'])
  // El estado sí los tiene, y el index privado los enseña: lo que sigue no pasa por casualidad.
  const privado = repo.archivos()[`${CARPETA_INDEX}/index.html`]!
  expect(privado).toContain('#7001')
  expect(privado).toContain('retirar el remolino')
  expect(privado).toContain('Esta sesión')
  const html = repo.archivos()[`${CARPETA_INDEX}/produccion-acme.html`]!
  const json = repo.archivos()[`${CARPETA_INDEX}/produccion-acme.json`]!
  expect(html).toContain('abcdef1234')
  expect(html).toContain('<dd>bien</dd>')
  expect(html).not.toContain('<script')
  expect(JSON.parse(json)).toEqual({ commit: 'abcdef1234', bien: true, foto: FOTO })
  for (const salida of [html, json]) {
    for (const prohibido of ['7001', '7002', 'retirar', 'remolino', 'ya no gira', 'Zanahoria', 'Berenjena', 'Esta sesión', 'claude', 'Agy', 'agy', 'Codex', 'codex', 'sin cuota', 'cola', 'issue', 'paso', 'acme', 'interno', 'ejemplo.invalid']) {
      expect(salida).not.toContain(prohibido)
    }
  }
})

test('el index dice qué hizo el último despertar: dio una orden y, marcado el paso, cerró algo', async ($, on) => {
  mock.store(on)
  const repo = repositorioDePrueba(
    on,
    [issue(346, 'Ajustar un formulario')],
    conPasos([{ paso: 'retirar el botón', hecho: false }, { paso: 'medir en el navegador', hecho: false }]),
    { medicion: medicionConReparto([ACME]) },
  )
  const fichaDeAcme = async () => {
    await $.command.run({ command: 'consumo', args: 'avance' } as never)
    return JSON.parse(repo.archivos()[`${CARPETA_INDEX}/index.json`]!).fichas[0]
  }
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('Siguiente paso: retirar el botón')
  let f = await fichaDeAcme()
  expect(f.despertar).toBe('dio una orden')
  expect(f.paso).toBe('retirar el botón')
  expect(f.issue).toBe(346)
  // Alguien marca el paso; el siguiente despertar encuentra un paso hecho más que el anterior.
  const fichero = repo.escrito()
  fichero.declarado['346'].pasos[0].hecho = true
  repo.poner(fichero)
  await despertar($, repo.entro())
  f = await fichaDeAcme()
  expect(f.despertar).toBe('cerró algo')
  expect(f.paso).toBe('medir en el navegador')
  expect(repo.archivos()[`${CARPETA_INDEX}/index.html`]).toContain('cerró algo')
  // Un despertar más sin que nadie marque nada ya no «cerró algo»: vuelve a ser una orden.
  await despertar($, repo.entro())
  f = await fichaDeAcme()
  expect(f.despertar).toBe('dio una orden')
  // El registro no se escribe en el fichero versionado.
  expect(JSON.stringify(repo.escrito())).not.toContain('pasosHechos')
})

test('un despertar sin pasos queda en el index como «paró»', async ($, on) => {
  mock.store(on)
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { medicion: medicionConReparto([ACME]) })
  await despertar($, BUCLE)
  expect(repo.entro()).toContain('parar')
  await $.command.run({ command: 'consumo', args: 'avance' } as never)
  const f = JSON.parse(repo.archivos()[`${CARPETA_INDEX}/index.json`]!).fichas[0]
  expect(f.despertar).toBe('paró')
  expect(f.paso).toBe('no hay paso')
  expect(f.despertar_cuando).toBe(FOTO)
})

// ── Leer GitHub cuando el envoltorio del repositorio no responde ─────────────────────────────────────
function sinEnvoltorio(on: unknown, identidad: string): { escrito: () => any } {
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[]; path?: string; text?: string; env?: Record<string, string> }) => unknown) => void
  let guardado = JSON.stringify({ cola: [346], herramientas: { gh: GH_DE_PRUEBA } })
  const bien = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
  contestar('ui.open', () => ({ value: undefined }))
  contestar('clock.now', () => ({ value: 1_780_000_000_000 }))
  contestar('session.id', () => ({ value: 'sesion' }))
  contestar('session.cwd', () => ({ value: 'F:/proyecto' }))
  contestar('session.root', () => ({ value: 'F:/proyecto' }))
  contestar('session.model', () => ({ value: 'claude-opus-5-5' }))
  let delControl = ''
  const esLocal = (ruta: unknown) => /orquestacion\.local\.json$/.test(String(ruta))
  contestar('fs.exists', (_$, e) => ({ value: esLocal(e.path) ? delControl !== '' : /orquestacion\.json$/.test(String(e.path)) }))
  contestar('fs.read', (_$, e) => ({ value: esLocal(e.path) ? delControl : guardado }))
  contestar('fs.write', (_$, e) => {
    if (esLocal(e.path)) delControl = String(e.text)
    else if (/orquestacion\.json$/.test(String(e.path))) guardado = String(e.text)
    return { value: undefined }
  })
  contestar('process.run', (_$, e) => {
    const argv = e.argv ?? []
    if (argv[0] === 'git' && argv.includes('remote')) return bien('https://github.com/acme/plataforma.git')
    if (argv[0] === 'git' && argv.includes('log')) return bien('')
    if (argv.some(a => a.endsWith(GH_DE_PRUEBA))) return { value: { exitCode: 3, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' } }
    if (argv[0] === 'gh' && argv.includes('token')) return bien('credencial-de-prueba')
    if (argv[0] === 'gh' && argv.includes('user')) return bien(identidad)
    if (argv[0] === 'gh' && argv.includes('list')) return bien(JSON.stringify([{ number: 346, title: 'Ajustar un formulario', labels: [], body: '', projectItems: [{}] }]))
    return { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } }
  })
  return { escrito: () => ({ ...JSON.parse(guardado), ...(delControl ? JSON.parse(delControl) : {}) }) }
}

test('si el envoltorio del repositorio no responde, el control lee como la cuenta dueña y lo dice', async ($, on) => {
  const repo = sinEnvoltorio(on, 'acme')
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('Esta sesión tiene la #346')
  expect(respuesta).toContain('leído con la credencial que gh guarda para «acme»')
  expect(respuesta).not.toContain('NO MEDIDO')
  expect(respuesta).not.toContain('credencial-de-prueba')
  expect(repo.escrito().router.issues_abiertas).toBe(1)
})

test('si esa credencial identifica a otra cuenta, no se usa: GitHub queda NO MEDIDO', async ($, on) => {
  const repo = sinEnvoltorio(on, 'otra-cuenta')
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('NO MEDIDO')
  expect(repo.escrito().router.issues_abiertas).toBe(null)
})

// ── El control no ensucia el repositorio ────────────────────────────────────────────────────────────
test('el control escribe su decisión en el fichero local y deja intacto el versionado', async ($, on) => {
  const declarado = { cola: [346], declarado: { '346': { falta: 'retirar un botón' } } }
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], declarado)
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  expect(repo.versionado()).toEqual(declarado)
  expect(repo.local().asignaciones['346'].trabajador).toBe('claude')
  expect(repo.local().clasificacion.length).toBe(1)
  expect(repo.local().cola).toBeUndefined()
  expect(repo.local().declarado).toBeUndefined()
})

test('«/consumo fuera» sí escribe en el versionado, y sólo la clave fuera', async ($, on) => {
  const declarado = { cola: [346], declarado: { '346': { falta: 'retirar un botón' } } }
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], declarado)
  await $.command.run({ command: 'consumo', args: 'fuera codex sin cuota' } as never)
  expect(Object.keys(repo.versionado()).sort()).toEqual(['cola', 'declarado', 'fuera'])
  expect(repo.versionado().fuera.codex).toContain('sin cuota')
  expect(repo.versionado().asignaciones).toBeUndefined()
})

test('un fichero versionado que aún trae la decisión de antes se respeta hasta que exista el local', async ($, on) => {
  const antiguo = { cola: [346, 347], asignaciones: { '347': { trabajador: 'claude', clase: 'Construcción', puntos: 0, peso: 'XS', esfuerzo: 'bajo', estado: 'vigente', desde: '2026-05-28T00:00:00.000Z', motivo: 'de antes' } } }
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario'), issue(347, 'Otro ajuste')], antiguo)
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  expect(repo.local().asignaciones['347'].trabajador).toBe('claude')
  expect(repo.local().asignaciones['346']).toBeUndefined()
  expect(repo.versionado()).toEqual(antiguo)
})

// ── Lo propio de cada repositorio va en `herramientas`, no en el mod ──────────────────────────────────
test('el envoltorio de gh sale de herramientas.gh; uno de bash se lanza con bash', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { herramientas: { gh: 'herramientas/gh-del-equipo.sh' } })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('Esta sesión tiene la #346')
  expect(respuesta).not.toContain('NO MEDIDO')
  const lista = repo.corridas().find(c => c.includes('list'))!
  expect(lista.slice(0, 2)).toEqual(['bash', 'F:/proyecto/herramientas/gh-del-equipo.sh'])
})

test('sin herramientas.gh y sin el envoltorio de siempre en el repositorio, no se inventa uno: GitHub queda NO MEDIDO y se dice por qué', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { herramientas: null })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(respuesta).toContain('NO MEDIDO')
  expect(respuesta).toContain('no declara herramientas.gh')
  expect(repo.corridas().some(c => c.includes('powershell'))).toBe(false)
})

test('el candado de suites se lee del fichero que declara herramientas.candado', async ($, on) => {
  repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { herramientas: { gh: GH_DE_PRUEBA, candado: '.suite.lock' }, existen: ['/.suite.lock'], candado: 'verify PID 4321' })
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Candado de suites tomado \(verify PID 4321\)/ })).toBeDefined()
})

// ── El peso sale de la etiqueta; «bloqueada» espera al dueño ────────────────────────────────────────
const deRouter = (numero: number, etiquetas: string[], cuerpo = ''): Issue => ({ numero, titulo: 'Ajustar un formulario', etiquetas, cuerpo, enProyecto: true, commits: [], medida: true })
// Un cuerpo que, deducido por palabras, contesta «sí» a las cinco preguntas.
const CUERPO_QUE_SE_PASA = 'Migración con RLS, toca el API y la web, causa no medida, se valida en navegador con pnpm e2e y hay que desplegar a producción.'

test('el peso se lee de la etiqueta peso:… antes que del texto; sin etiqueta, se deduce', () => {
  const sinEtiqueta = pesar(deRouter(1, [], CUERPO_QUE_SE_PASA), undefined)
  expect(sinEtiqueta.puntos).toBe(5)
  expect(tabla(sinEtiqueta.puntos).peso).toBe('XL')
  expect(sinEtiqueta.etiqueta).toBe(null)
  const conEtiqueta = pesar(deRouter(1, ['backend', 'peso:M'], CUERPO_QUE_SE_PASA), undefined)
  expect(conEtiqueta.etiqueta).toBe('M')
  expect(tabla(conEtiqueta.puntos).peso).toBe('M')
  for (const [etiqueta, peso] of [['peso:XS', 'XS'], ['Peso: s', 'S'], ['peso:L', 'L'], ['peso:xl', 'XL']] as const) expect(tabla(pesar(deRouter(1, [etiqueta], CUERPO_QUE_SE_PASA), undefined).puntos).peso).toBe(peso)
  // Una etiqueta que no es un peso no cuenta.
  expect(pesar(deRouter(1, ['peso:enorme', 'sobrepeso:M'], ''), undefined).etiqueta).toBe(null)
  // Lo declarado manda cuando contesta las cinco preguntas; si contesta sólo alguna, la etiqueta sigue valiendo.
  const todo = { capas: false, sensible: false, diagnostico: false, navegador: true, produccion: false }
  expect(tabla(pesar(deRouter(1, ['peso:XL'], CUERPO_QUE_SE_PASA), todo).puntos).peso).toBe('S')
  expect(tabla(pesar(deRouter(1, ['peso:M'], CUERPO_QUE_SE_PASA), { produccion: false }).puntos).peso).toBe('M')
})

const entrada = (issues: Issue[], estado: Record<string, unknown>, actividad: Actividad = {}) => ({ raiz: 'F:/proyecto', issues, estado, actividad, ahora: '2026-05-28T20:00:00.000Z', abiertas: new Set(issues.map(i => i.numero)) })

test('con la etiqueta de peso M, una issue cuyo texto daría XL se asigna en vez de quedar «por partir»', () => {
  const s = enrutar(entrada([deRouter(7, ['peso:M'], CUERPO_QUE_SE_PASA)], { cola: [7] }))
  expect(s.filas[0]!.situacion).toBe('asignada')
  expect(s.filas[0]!.peso).toBe('M')
  const sin = enrutar(entrada([deRouter(7, [], CUERPO_QUE_SE_PASA)], { cola: [7] }))
  expect(sin.filas[0]!.situacion).toBe('partir')
})

test('una issue con la etiqueta «bloqueada» queda en «espera al dueño», salvo que lo declarado diga otra cosa', () => {
  const s = enrutar(entrada([deRouter(7, ['bloqueada', 'peso:S']), deRouter(8, ['peso:S'])], { cola: [7, 8] }))
  expect(s.filas[0]!.situacion).toBe('espera al dueño')
  expect(s.filas[0]!.nota).toContain('bloqueada')
  expect(s.asignaciones['7']).toBeUndefined()
  // No detiene la cola: la sesión recibe la siguiente.
  expect(s.asignaciones['8']!.trabajador).toBe('claude')
  // Lo declarado dice otra cosa: el repositorio escribió qué falta, y eso manda sobre la etiqueta.
  const declarada = enrutar(entrada([deRouter(7, ['Bloqueada', 'peso:S'])], { cola: [7], declarado: { '7': { falta: 'ya se destrabó: retirar el botón' } } }))
  expect(declarada.filas[0]!.situacion).toBe('asignada')
  // Sin la etiqueta, como siempre.
  expect(enrutar(entrada([deRouter(7, ['peso:S'])], { cola: [7] })).filas[0]!.situacion).toBe('asignada')
})

// ── «A medias» no es «parado» ───────────────────────────────────────────────────────────────────────
const deAgy = { '7': { trabajador: 'agy', clase: 'Construcción', puntos: 2, peso: 'M', esfuerzo: 'alto', estado: 'vigente', desde: '2026-05-28T18:00:00.000Z', motivo: 'peso M', rama: 'agy/7' } }

test('un externo sin commits hace más de 30 minutos y sin nada a medias pasa a «por retomar»', () => {
  const s = enrutar(entrada([deRouter(7, ['peso:M'])], { cola: [7], asignaciones: deAgy }, { agy: { rama: 'agy/7', issue: 7, hace_min: 45, sin_confirmar: 0, stash: 0 } }))
  expect(s.asignaciones['7']!.estado).toBe('por retomar')
  expect(s.avisos.join(' ')).toContain('pasa a «por retomar»')
})

test('con ficheros sin confirmar, pasados los 30 minutos, NO pasa a «por retomar»: queda vigente y se pregunta al dueño', () => {
  const s = enrutar(entrada([deRouter(7, ['peso:M'])], { cola: [7], asignaciones: deAgy }, { agy: { rama: 'agy/7', issue: 7, hace_min: 45, sin_confirmar: 3, stash: 0 } }))
  expect(s.asignaciones['7']!.estado).toBe('vigente')
  expect(s.asignaciones['7']!.motivo).toBe(MOTIVO_A_MEDIAS)
  expect(s.asignaciones['7']!.motivo).toBe('tiene trabajo a medias: preguntar al dueño antes de reasignar')
  expect(s.asignaciones['7']!.trabajador).toBe('agy')
  expect(s.avisos.join(' ')).toContain('3 ficheros sin confirmar')
  expect(s.avisos.join(' ')).not.toContain('por retomar')
})

test('con entradas en el stash de su rama, pasados los 30 minutos, tampoco pasa a «por retomar»', () => {
  const s = enrutar(entrada([deRouter(7, ['peso:M'])], { cola: [7], asignaciones: deAgy }, { agy: { rama: 'agy/7', issue: 7, hace_min: 600, sin_confirmar: 0, stash: 2 } }))
  expect(s.asignaciones['7']!.estado).toBe('vigente')
  expect(s.asignaciones['7']!.motivo).toBe(MOTIVO_A_MEDIAS)
  expect(s.avisos.join(' ')).toContain('2 entradas en el stash')
  // El trabajo a medias de OTRA rama no retiene esta issue.
  const otra = enrutar(entrada([deRouter(7, ['peso:M'])], { cola: [7], asignaciones: deAgy }, { agy: { rama: 'agy/9', issue: 9, hace_min: 600, sin_confirmar: 4, stash: 2 } }))
  expect(otra.asignaciones['7']!.estado).toBe('por retomar')
})

test('el control mide los ficheros sin confirmar y el stash del árbol del externo sin tomar candados, y no lo da por parado', async ($, on) => {
  const estado = { cola: [7], asignaciones: { '7': { ...deAgy['7'], desde: '2020-01-01T00:00:00.000Z' } } }
  const repo = repositorioDePrueba(on, [issue(7, 'Ajustar un formulario', ['peso:M'])], estado, {
    git: argv => {
      if (!argv.includes('F:/proyecto-agy')) return null
      if (argv.includes('rev-parse')) return 'agy/7'
      if (argv.includes('log')) return '1000000000'
      if (argv.includes('status')) return ' M src/uno.ts\n?? src/dos.ts\n'
      if (argv.includes('stash')) return 'WIP on agy/7: abc1234 algo\nOn otra/rama: no cuenta\n'
      return null
    },
  })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'agentes' } as never))
  expect(repo.escrito().asignaciones['7'].estado).toBe('vigente')
  expect(repo.escrito().asignaciones['7'].motivo).toBe(MOTIVO_A_MEDIAS)
  expect(respuesta).toContain('2 ficheros sin confirmar y 1 entradas en el stash')
  const medidas = repo.corridas().filter(c => c[0] === 'git' && (c.includes('status') || c.includes('stash')))
  expect(medidas.length).toBeGreaterThan(1)
  for (const c of medidas) expect(c[1]).toBe('--no-optional-locks')
  expect(repo.corridas().some(c => c[0] === 'git' && c.includes('fetch'))).toBe(false)
})

// ── El index vivo en el panel ───────────────────────────────────────────────────────────────────────
const INDEX_VIVO = {
  cuellos: [
    { gravedad: 'alta', tipo: 'migracion', que: 'El número de migración 0002 está tomado 2 veces: agy/12 (0002_a.sql) y codex/34 (0002_b.sql).', desde: '2026-05-28 20:00 UTC', repositorio: 'plataforma' },
    { gravedad: 'media', tipo: 'stash', que: 'La rama agy/12 tiene 1 entrada en el stash.', desde: '2026-05-28 19:00 UTC', repositorio: 'plataforma' },
  ],
  foto: '2026-05-28 20:26 UTC',
  repositorios: [],
}

test('con el guion instalado, el mod lo lanza y la tercera pregunta añade una línea con el primer cuello y la ruta del index', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { vivo: INDEX_VIVO, medicion: medicionConReparto([ACME]) })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'avance' } as never))
  // El mod deja de generar el index por su cuenta: lo escribe el guion, y aquí sólo se lanza y se lee.
  expect(repo.corridas().some(c => c[0] === 'node' && String(c[1]).replace(/\\/g, '/') === `${CARPETA_VIVO}/indice.mjs`)).toBe(true)
  expect(Object.keys(repo.archivos()).some(ruta => ruta.endsWith('index.html') || ruta.endsWith('index.json'))).toBe(false)
  expect(respuesta).toContain(`Index: ${CARPETA_VIVO}/index.html`)
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Index vivo · ALTA · El número de migración 0002 está tomado 2 veces.*\(y 1 más\) · C:\/Users\/prueba\/\.claude\/consumo-index\/index\.html/ })).toBeDefined()
  expect(await pane.find({ text: /Index vivo sin instalar/ })).toBeUndefined()
})

test('sin el guion instalado, el panel dice cómo instalarlo y el mod sigue dejando su index al medir', async ($, on) => {
  const repo = repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { medicion: medicionConReparto([ACME]) })
  const respuesta = JSON.stringify(await $.command.run({ command: 'consumo', args: 'avance' } as never))
  expect(respuesta).toContain(`Index: ${CARPETA_INDEX}/index.html`)
  expect(repo.archivos()[`${CARPETA_INDEX}/index.html`]).toBeDefined()
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Index vivo sin instalar: «node herramientas\/instalar\.mjs --raiz/ })).toBeDefined()
})

test('los cuellos de botella no van al prompt de sistema: sólo al panel', async ($, on) => {
  repositorioDePrueba(on, [issue(346, 'Ajustar un formulario')], { cola: [346] }, { vivo: INDEX_VIVO, medicion: medicionConReparto([ACME]) })
  // Debajo del mod no hay motor que componga: la prueba contesta con un prompt sin secciones.
  ;(on as unknown as (evento: string, hook: () => unknown) => void)('prompt.compose', () => ({ sections: [] }))
  await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  await $.command.run({ command: 'consumo', args: 'avance' } as never)
  const compuesto = JSON.stringify(await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never))
  // La sección del control sí está (la orden de la #346): lo que sigue no pasa por estar vacío el prompt.
  expect(compuesto).toContain('#346')
  expect(compuesto).not.toContain('migración 0002')
  expect(compuesto).not.toContain('cuello')
})
