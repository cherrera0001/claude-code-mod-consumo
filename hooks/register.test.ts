import { expect, test } from 'claude-code/testing'

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

function repositorioDePrueba(on: unknown, issues: IssueDePrueba[], estado: Record<string, unknown>): { escrito: () => any; poner: (e: unknown) => void; entro: () => string; romper: () => void } {
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[]; path?: string; text?: string }) => unknown) => void
  let guardado = JSON.stringify(estado)
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
    return { value: /orquestacion\.json$/.test(String(e.path)) }
  })
  contestar('fs.read', () => ({ value: guardado }))
  contestar('fs.write', (_$, e) => {
    guardado = String(e.text)
    return { value: undefined }
  })
  contestar('process.run', (_$, e) => {
    const argv = e.argv ?? []
    if (argv.some(a => a.endsWith('gh-vt.ps1')) && argv.includes('list')) return { value: { exitCode: 0, stdout: JSON.stringify(issues), stderr: '' } }
    if (argv[0] === 'git' && argv.includes('remote')) return { value: { exitCode: 0, stdout: 'https://github.com/acme/plataforma.git', stderr: '' } }
    if (argv[0] === 'git' && argv.includes('log') && argv.includes('main')) return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } }
  })
  return {
    escrito: () => JSON.parse(guardado),
    poner: e => {
      guardado = JSON.stringify(e)
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
