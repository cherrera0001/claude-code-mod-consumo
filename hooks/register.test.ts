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
    expect(await pane.find({ text: /Ahora/ })).toBeDefined()
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

// La orquestación se ve: quién trabaja, quién quedó fuera y qué hay que redistribuir.
test('la orquestación muestra agentes externos, el que quedó fuera y lo que hay que redistribuir', async ($, on) => {
  const contestar = on as unknown as (evento: string, hook: ($: unknown, e: { argv?: readonly string[] }) => unknown) => void
  const estado = {
    ahora: 1_780_000_000,
    agentes: [
      { nombre: 'agy', issue: 345, rama: 'agy/345', commits: 3, sin_confirmar: 0, ultima: 1_779_999_900, con_arbol: true, estado: 'activo', motivo: '', hace_min: 1.5, reasignado_a: '' },
      { nombre: 'codex', issue: 344, rama: 'codex/344', commits: 5, sin_confirmar: 0, ultima: 1_779_990_000, con_arbol: true, estado: 'fuera', motivo: 'sin cuota', hace_min: 166, reasignado_a: 'claude' },
      { nombre: 'codex', issue: 314, rama: 'codex/314', commits: 0, sin_confirmar: 5, ultima: 1_779_995_000, con_arbol: true, estado: 'fuera', motivo: 'sin cuota', hace_min: 83, reasignado_a: '' },
    ],
    externos: 2,
    externos_activos: 1,
    subagentes: { total: 8, activos: 1, ultimos: [{ etiqueta: 'QA CONTRA de #333', hace_min: 0.3, activo: true }] },
    por_redistribuir: [314],
  }
  contestar('ui.open', () => ({ value: undefined }))
  contestar('clock.now', () => ({ value: 1_780_000_000_000 }))
  contestar('session.id', () => ({ value: 'sesion' }))
  contestar('session.cwd', () => ({ value: 'F:/proyecto' }))
  contestar('session.root', () => ({ value: 'F:/proyecto' }))
  contestar('fs.exists', () => ({ value: false }))
  contestar('process.run', (_$, e) =>
    (e.argv ?? []).includes('--raiz') && !(e.argv ?? []).includes('--factura')
      ? { value: { exitCode: 0, stdout: JSON.stringify(estado), stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'sin procesos en la prueba' } },
  )
  const respuesta = await $.command.run({ command: 'consumo', args: 'agentes' } as never)
  expect(JSON.stringify(respuesta)).toContain('2 agentes externos (1 activos, fuera: codex)')
  expect(JSON.stringify(respuesta)).toContain('por redistribuir: #314')
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Orquestación · 2 agentes externos \(1 activos\) · 8 subagentes de la sesión/ })).toBeDefined()
  expect(await pane.find({ text: /agy\s+#345 · 3 commits/ })).toBeDefined()
  expect(await pane.find({ text: /codex\s+#344 · 5 commits.*sin cuota.*reasignada a claude/ })).toBeDefined()
  expect(await pane.find({ text: /Por redistribuir: #314/ })).toBeDefined()
  expect(await pane.find({ text: /subagente «QA CONTRA de #333» · trabajando/ })).toBeDefined()
})

// Sin ramas de agentes, la sección lo dice en vez de quedar vacía.
test('sin agentes externos, la orquestación lo dice', async $ => {
  const pane = await $.ui.mount({ plugin: 'consumo', surface: 'terminal', component: 'Pane', requestId: 'consumo', props, viewport })
  expect(await pane.find({ text: /Orquestación · 0 agentes externos/ })).toBeDefined()
  expect(await pane.find({ text: /ningún agente externo con rama/ })).toBeDefined()
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
  expect(await pane.find({ text: /sin tarea todavía/ })).toBeDefined()
  expect(await pane.find({ text: /no existe la transcripcion/ })).toBeUndefined()
  expect(await pane.find({ text: /Cobertura de pruebas/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /pytest/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /Avance/ })).toBeDefined()
})
