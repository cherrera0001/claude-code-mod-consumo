// El control de `consumo` 2.0, sin entrada ni salida: recibe lo medido (issues, commits, ramas, lo declarado en
// .claude/orquestacion.json) y devuelve la decisión. Todo lo que toca disco, git o GitHub vive en
// register.tsx; aquí sólo se decide, para que la decisión se pueda probar con datos fijos.

export type Clase = 'Cierre' | 'Construcción' | 'Interina' | 'Decisión' | 'Épica'
export type Peso = 'XS' | 'S' | 'M' | 'L' | 'XL'
export type Trabajador = 'claude' | 'agy' | 'codex'
export const EXTERNOS: readonly Trabajador[] = ['agy', 'codex']
export const TRABAJADORES: readonly Trabajador[] = ['claude', 'agy', 'codex']

/** Las cinco preguntas del peso. Cada «sí» es un punto; se contesta sobre LO QUE FALTA, no sobre la issue entera. */
export type Criterios = {
  capas: boolean
  sensible: boolean
  diagnostico: boolean
  navegador: boolean
  produccion: boolean
}
export const PREGUNTAS: readonly (keyof Criterios)[] = ['capas', 'sensible', 'diagnostico', 'navegador', 'produccion']

export type Paso = { paso: string; hecho: boolean }

/** Lo que la sesión o el dueño dejan escrito de una issue y que ni git ni GitHub saben. */
export type Declarado = Partial<Criterios> & {
  clase?: Clase
  /** Qué falta, en una línea: es lo que se pesa. */
  falta?: string
  /** Sólo la construye esta sesión (orden de despliegue dada, trabajo sin empujar a propósito). */
  solo_sesion?: boolean
  /** Los pasos que la cierran, en orden. Alguien marca `hecho`; el control no lo da por hecho. */
  pasos?: Paso[]
  /** El criterio con que se da por bueno el paso en curso. */
  criterio?: string
  /** Los archivos que el trabajo toca. */
  archivos?: string[]
  /**
   * Lo que sólo el dueño puede destrabar (una credencial, una decisión). Mientras esté escrito, la issue sigue
   * siendo de quien la tiene pero no lo ocupa: el control le da la siguiente de la cola.
   */
  espera?: string
}

export type Issue = {
  numero: number
  titulo: string
  etiquetas: string[]
  cuerpo: string
  /** null: no se pudo medir (GitHub no respondió). */
  enProyecto: boolean | null
  /** Commits de main que la nombran, «sha asunto». */
  commits: string[]
  /** false: la issue viene de la cola escrita y no de GitHub; título y etiquetas no están medidos. */
  medida: boolean
}

export type Asignacion = {
  trabajador: Trabajador
  clase: Clase
  puntos: number
  peso: Peso
  esfuerzo: string
  /** Quien hace el CONTRA en sólo lectura (peso L), o por qué no hay nadie. */
  contra?: Trabajador
  sin_contra?: string
  estado: 'vigente' | 'por retomar'
  desde: string
  motivo: string
  arbol?: string
  rama?: string
  encargo?: string
}

export type Fila = {
  numero: number
  titulo: string
  clase: Clase
  puntos: number | null
  peso: Peso | null
  esfuerzo: string | null
  trabajador: Trabajador | null
  /** asignada · en cola · espera al dueño · épica · interina · partir · contra */
  situacion: 'asignada' | 'en cola' | 'espera al dueño' | 'épica' | 'interina' | 'partir'
  nota: string
  /** De cada pregunta del peso, si la respuesta está declarada o la dedujo el router del texto. */
  origen: Record<keyof Criterios, 'declarado' | 'deducido'> | null
  criterios: Criterios | null
}

export type Estado = {
  _nota?: string
  fuera?: Record<string, string>
  reasignado?: Record<string, string>
  cola?: number[]
  declarado?: Record<string, Declarado>
  no_tocar?: string[]
  asignaciones?: Record<string, Asignacion>
  clasificacion?: Fila[]
  router?: { github: string; issues_abiertas: number | null; pendientes?: string[] }
  /** Dónde publica el servicio su salud (commit y estado). Sólo de ahí sale la ficha pública de producción. */
  produccion?: { salud?: string }
  [otra: string]: unknown
}

/** Minutos desde la última actividad de la rama de cada trabajador externo; null si no tiene rama a la vista. */
export type Actividad = Partial<Record<Trabajador, { rama: string; issue: number; hace_min: number } | null>>

export const INACTIVO_MIN = 30

// La cola la escribe cada repositorio en su .claude/orquestacion.json (`cola`). Sin ella, el control sigue el
// orden de las issues que no figuran en ninguna: por número.
export const COLA_INICIAL: readonly number[] = []

export const NO_TOCAR_INICIAL: readonly string[] = [
  'definicion/',
  '.env',
  'db/migrations/ (las selladas: sólo migraciones nuevas, y sólo si el encargo las pide)',
  'CLAUDE.md',
  'gobernanza/LEDGER.md',
  'gobernanza/SESSION_STATE.json',
  '.claude/orquestacion.json',
]

export const FRASE_ENCARGO = 'No abras issues ni dejes un comentario como cierre.'

/** Cada externo trabaja en su propio árbol, junto al del proyecto: <raíz>-agy y <raíz>-codex, rama <agente>/<número>. */
export function arbol(raiz: string, quien: Trabajador): string {
  return quien === 'claude' ? raiz : `${raiz}-${quien}`
}

const TABLA: readonly { peso: Peso; esfuerzo: string }[] = [
  { peso: 'XS', esfuerzo: 'bajo' },
  { peso: 'S', esfuerzo: 'medio' },
  { peso: 'M', esfuerzo: 'alto' },
  { peso: 'L', esfuerzo: 'muy alto' },
  { peso: 'XL', esfuerzo: 'máximo, con plan antes' },
  { peso: 'XL', esfuerzo: 'máximo, con plan antes' },
]

/** Puntos → peso y esfuerzo. El modelo no se asigna: es el de la sesión, y se lee. */
export function tabla(puntos: number): { peso: Peso; esfuerzo: string } {
  return TABLA[Math.max(0, Math.min(5, puntos))]!
}

const sinAcentos = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

function tieneEtiqueta(i: Issue, patron: RegExp): boolean {
  return i.etiquetas.some(e => patron.test(sinAcentos(e)))
}

/** Una sola clase por issue. Lo declarado manda; después, en este orden: Épica, Decisión, Interina, Cierre, Construcción. */
export function clasificar(i: Issue, d: Declarado | undefined): Clase {
  if (d?.clase) return d.clase
  const titulo = sinAcentos(i.titulo)
  if (tieneEtiqueta(i, /^(type:)?(epic|epica)$/) || /^\s*(\[epic\]|epica\b)/.test(titulo)) return 'Épica'
  if (tieneEtiqueta(i, /^decision-humana$|^type:decision$|^credencial/) || /\bp-\d{1,2}\b/.test(titulo)) return 'Decisión'
  if (tieneEtiqueta(i, /^interina$/)) return 'Interina'
  if (i.commits.length > 0) return 'Cierre'
  return 'Construcción'
}

const CAPAS: readonly RegExp[] = [
  /migraci|\bddl\b|\bsql\b|base de datos|\bdb\//,
  /\bapi\b|controlador|controller|endpoint|guard\b|servicio de dominio/,
  /contrato|openapi|packages\/contracts/,
  /\bweb\b|pantalla|pagina|page\.tsx|frontend|formulario/,
  /packages\/ui|@vt\/ui|componente de ui/,
]

/** Deduce del texto las cinco respuestas. Es una deducción y así queda marcada: lo declarado la pisa pregunta a pregunta. */
export function deducir(i: Issue): Criterios {
  const texto = sinAcentos(`${i.titulo}\n${i.etiquetas.join(' ')}\n${i.cuerpo}`)
  const capas = CAPAS.filter(c => c.test(texto)).length
  return {
    capas: capas > 1,
    sensible: /migraci|\brls\b|permiso|\bsesion\b|membresi|datos personales|\bpii\b|\brol(es)?\b/.test(texto),
    diagnostico: /causa (no|sin) (medida|conocida|demostrada)|no medido|intermitente|sin diagnostic|se desconoce/.test(texto),
    navegador: /navegador|playwright|pnpm e2e|pnpm gate|\b1440\b|\b390\b|recorrido por rol/.test(texto),
    produccion: /produccion|desplegar|despliegue|vigia|pnpm vigilar|preflight|\bpuerta\b|pnpm verify/.test(texto),
  }
}

export function pesar(i: Issue, d: Declarado | undefined): { criterios: Criterios; origen: Record<keyof Criterios, 'declarado' | 'deducido'>; puntos: number } {
  const deducido = deducir(i)
  const criterios = {} as Criterios
  const origen = {} as Record<keyof Criterios, 'declarado' | 'deducido'>
  for (const p of PREGUNTAS) {
    const dicho = d?.[p]
    criterios[p] = typeof dicho === 'boolean' ? dicho : deducido[p]
    origen[p] = typeof dicho === 'boolean' ? 'declarado' : 'deducido'
  }
  return { criterios, origen, puntos: PREGUNTAS.filter(p => criterios[p]).length }
}

/** El criterio de aceptación tal como lo trae la issue; si no tiene sección reconocible, se dice y se remite a ella. */
export function criterioDeAceptacion(i: Issue): string {
  const lineas = i.cuerpo.split(/\r?\n/)
  const desde = lineas.findIndex(l => /^#{1,4}\s*(criterios?( de aceptaci[oó]n)?|definici[oó]n de terminado|dod)\b/i.test(l.trim()))
  if (desde < 0) return `Los criterios escritos en la issue #${i.numero} (no trae una sección «Criterios de aceptación» que se pueda copiar aquí).`
  const resto = lineas.slice(desde + 1)
  const hasta = resto.findIndex(l => /^#{1,4}\s/.test(l.trim()))
  return (hasta < 0 ? resto : resto.slice(0, hasta)).join('\n').trim().slice(0, 2400)
}

export function encargo(i: Issue, quien: Trabajador, papel: 'construir' | 'contra', noTocar: readonly string[], raiz: string): string {
  const cabecera =
    papel === 'construir'
      ? `Encargo para ${quien}: issue #${i.numero}${i.titulo ? ` — ${i.titulo}` : ''}. Trabajas en ${arbol(raiz, quien)}, rama ${quien}/${i.numero}. Una sola issue.`
      : `Encargo para ${quien}: CONTRA en sólo lectura de la issue #${i.numero}${i.titulo ? ` — ${i.titulo}` : ''}. Lees el árbol y dictaminas; no editas, no ejecutas suites, no cierras.`
  return [
    cabecera,
    `Criterio de aceptación: ${criterioDeAceptacion(i)}`,
    `No puedes tocar: ${noTocar.join('; ')}.`,
    'No empujas main, no migras producción y no despliegas el API: eso lo hace la sesión principal con orden del dueño.',
    FRASE_ENCARGO,
  ].join('\n')
}

export type Entrada = {
  /** Raíz del repositorio de trabajo, con barras normales. */
  raiz: string
  issues: Issue[]
  estado: Estado
  actividad: Actividad
  /** ISO de ahora; va a `desde` de las asignaciones nuevas. */
  ahora: string
  /** Números que GitHub dice abiertos; null si no se pudo medir (entonces no se da nada por cerrado). */
  abiertas: ReadonlySet<number> | null
}

export type Salida = { filas: Fila[]; asignaciones: Record<string, Asignacion>; avisos: string[] }

/**
 * Decide. Reglas, en orden:
 *  1. Una asignación vigente no se reasigna, salvo que su trabajador esté `fuera`, su issue se haya cerrado, o
 *     estuviera «por retomar» desde el router anterior.
 *  2. Un externo sin actividad en su rama más de 30 minutos pasa a «por retomar»: este router lo marca y el
 *     siguiente lo reasigna. No se queda marcado.
 *  3. Un trabajador, una issue (construir o hacer el CONTRA lo ocupa por igual).
 *  4. Decisión: nadie; «espera al dueño». Épica e Interina: sin modelo ni trabajador. XL: no se asigna entera.
 *  5. Lo que toca producción o está marcado `solo_sesion` sólo lo construye esta sesión.
 *  6. Una asignación cuya issue tiene `espera` escrito no ocupa a nadie: sigue siendo de su trabajador y sigue
 *     a la vista, pero ni él ni su revisor quedan retenidos y la cola no se detiene detrás de ella. Tampoco pasa a
 *     «por retomar» por falta de actividad: no hay nada que mover mientras el dueño no la destrabe.
 */
export function enrutar(e: Entrada): Salida {
  const fuera = Object.fromEntries(Object.entries(e.estado.fuera ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const declarado = e.estado.declarado ?? {}
  const noTocar = e.estado.no_tocar?.length ? e.estado.no_tocar : NO_TOCAR_INICIAL
  const cola = e.estado.cola?.length ? e.estado.cola : COLA_INICIAL
  const porNumero = new Map(e.issues.map(i => [i.numero, i]))
  const avisos: string[] = []
  const asignaciones: Record<string, Asignacion> = {}
  const ocupado = new Map<Trabajador, number>()

  // 1 y 2 · lo que ya estaba asignado.
  for (const [clave, previa] of Object.entries(e.estado.asignaciones ?? {})) {
    const numero = Number(clave)
    const quien = previa.trabajador
    if (e.abiertas && !e.abiertas.has(numero)) {
      avisos.push(`#${numero} ya no está abierta: ${quien} queda libre.`)
      continue
    }
    if (fuera[quien]) {
      avisos.push(`#${numero} sale de ${quien} (fuera: ${fuera[quien]}).`)
      continue
    }
    if (previa.estado === 'por retomar') {
      avisos.push(`#${numero} estaba por retomar en ${quien}: se reasigna.`)
      continue
    }
    const act = quien === 'claude' ? undefined : e.actividad[quien]
    // Recién asignada todavía no hay rama: los 30 minutos corren desde lo último entre el encargo y la rama.
    const desdeEncargo = (Date.parse(e.ahora) - Date.parse(previa.desde)) / 60_000
    const enRama = act && act.issue === numero ? act.hace_min : Number.POSITIVE_INFINITY
    const enEspera = Boolean(declarado[clave]?.espera)
    const parado = !enEspera && quien !== 'claude' && !(Math.min(enRama, Number.isFinite(desdeEncargo) ? desdeEncargo : Number.POSITIVE_INFINITY) <= INACTIVO_MIN)
    const contra = previa.contra && !fuera[previa.contra] ? previa.contra : undefined
    asignaciones[clave] = parado
      ? { ...previa, contra, estado: 'por retomar', motivo: act && act.issue === numero ? `sin actividad en ${act.rama} hace ${Math.round(act.hace_min)} min` : `sin rama ${quien}/${numero} a la vista` }
      : { ...previa, contra }
    if (!enEspera) {
      ocupado.set(quien, numero)
      if (contra) ocupado.set(contra, numero)
    }
    if (parado) avisos.push(`#${numero} pasa a «por retomar» (${asignaciones[clave]!.motivo}); el siguiente router la reasigna.`)
  }

  const libre = (t: Trabajador): boolean => !fuera[t] && !ocupado.has(t)
  const sesionEnDespliegue = (): boolean => {
    const n = ocupado.get('claude')
    if (n === undefined) return false
    const i = porNumero.get(n)
    return i ? pesar(i, declarado[String(n)]).criterios.produccion : false
  }

  // 3 a 5 · la cola, en su orden; después, lo que esté abierto y no figure en ella.
  const orden = [...cola.filter(n => porNumero.has(n)), ...e.issues.map(i => i.numero).filter(n => !cola.includes(n)).sort((a, b) => a - b)]
  const filas: Fila[] = []
  let colaDetenida = false
  for (const numero of orden) {
    const i = porNumero.get(numero)!
    const d = declarado[String(numero)]
    const clase = clasificar(i, d)
    const base = { numero, titulo: i.titulo, clase }
    const vacia = { puntos: null, peso: null, esfuerzo: null, trabajador: null, origen: null, criterios: null }
    if (clase === 'Decisión') {
      filas.push({ ...base, ...vacia, situacion: 'espera al dueño', nota: 'espera al dueño' })
      continue
    }
    if (clase === 'Épica') {
      filas.push({ ...base, ...vacia, situacion: 'épica', nota: 'se cierra sola cuando cierran sus hijas' })
      continue
    }
    if (clase === 'Interina') {
      filas.push({ ...base, ...vacia, situacion: 'interina', nota: 'código en main bajo decisión interina: no se cierra sin la ratificación del dueño' })
      continue
    }
    const ya0 = asignaciones[String(numero)]
    const sinMedir = !i.medida && !PREGUNTAS.some(p => typeof d?.[p] === 'boolean')
    if (sinMedir && !ya0) {
      // Sin GitHub y sin nada declarado no hay con qué pesar: no se asigna a ciegas ni se salta la cola.
      colaDetenida = true
      filas.push({ ...base, ...vacia, situacion: 'en cola', nota: 'peso sin medir: GitHub no respondió y no hay nada declarado sobre lo que falta' })
      continue
    }
    const { criterios, origen, puntos } = pesar(i, d)
    const t = tabla(puntos)
    const medido = { puntos, peso: t.peso, esfuerzo: t.esfuerzo, origen, criterios }
    const falta = d?.falta ? ` Falta: ${d.falta}` : ''

    const ya = asignaciones[String(numero)]
    if (ya) {
      // Vigente: no se reasigna. El peso se vuelve a medir y se anota, porque lo que falta cambia.
      asignaciones[String(numero)] = { ...ya, clase, puntos, peso: t.peso, esfuerzo: t.esfuerzo }
      filas.push({ ...base, ...medido, trabajador: ya.trabajador, situacion: 'asignada', nota: `${ya.estado}: ${ya.motivo}.${falta}` })
      continue
    }
    if (t.peso === 'XL') {
      filas.push({ ...base, ...medido, trabajador: null, situacion: 'partir', nota: `no se asigna entera: se parte en issues de peso L o M, con plan antes.${falta}` })
      continue
    }

    const soloSesion = Boolean(d?.solo_sesion) || criterios.produccion
    let quien: Trabajador | null = null
    let motivo = ''
    if (libre('claude') && !colaDetenida) {
      quien = 'claude'
      motivo = `primera de la cola sin dueño; peso ${t.peso}`
    } else if (t.peso === 'M' && !soloSesion && sesionEnDespliegue()) {
      if (!i.medida) {
        // Un encargo cerrado lleva el criterio de aceptación de la issue: sin leerla no hay qué encargar.
        motivo = 'iría a agy, pero GitHub no respondió y sin leer la issue no hay criterio de aceptación que encargarle'
      } else if (libre('agy')) {
        quien = 'agy'
        motivo = `peso M y la sesión está en el despliegue de #${ocupado.get('claude')}`
      } else {
        motivo = fuera.agy ? `iría a agy, que está fuera (${fuera.agy})` : `iría a agy, ocupado con #${ocupado.get('agy')}`
      }
    }
    if (!quien) {
      const tras = ocupado.get('claude')
      filas.push({ ...base, ...medido, trabajador: null, situacion: 'en cola', nota: `en cola${tras === undefined ? '' : ` tras #${tras}`}${motivo ? `; ${motivo}` : ''}${soloSesion ? '; sólo la construye esta sesión' : ''}.${falta}` })
      continue
    }

    // Regla 6: la que espera al dueño se anota a su trabajador, pero no lo ocupa ni retiene a un revisor.
    const enEspera = Boolean(d?.espera)
    if (enEspera) motivo = `${motivo}; espera al dueño y no ocupa a ${quien}`
    const nueva: Asignacion = { trabajador: quien, clase, puntos, peso: t.peso, esfuerzo: t.esfuerzo, estado: 'vigente', desde: e.ahora, motivo }
    if (!enEspera) ocupado.set(quien, numero)
    if (quien !== 'claude') {
      nueva.arbol = arbol(e.raiz, quien)
      nueva.rama = `${quien}/${numero}`
      nueva.encargo = encargo(i, quien, 'construir', noTocar, e.raiz)
    }
    // Lo reservado a esta sesión no se reabre: no se le busca revisor.
    if (t.peso === 'L' && !d?.solo_sesion && !enEspera) {
      const lector = EXTERNOS.find(x => x !== quien && libre(x))
      if (lector) {
        nueva.contra = lector
        ocupado.set(lector, numero)
        nueva.encargo = encargo(i, lector, 'contra', noTocar, e.raiz)
      } else {
        nueva.sin_contra = EXTERNOS.map(x => (fuera[x] ? `${x} fuera (${fuera[x]})` : `${x} ocupado con #${ocupado.get(x)}`)).join('; ')
        avisos.push(`#${numero} (peso L) sin CONTRA externo: ${nueva.sin_contra}.`)
      }
    }
    asignaciones[String(numero)] = nueva
    filas.push({ ...base, ...medido, trabajador: quien, situacion: 'asignada', nota: `${motivo}.${falta}` })
  }
  return { filas, asignaciones, avisos }
}

export const NOMBRE: Record<Trabajador, string> = { claude: 'Esta sesión', agy: 'Agy', codex: 'Codex' }

/** Qué hará el próximo despertar con una asignación: seguir, reasignar o esperar. Es la orden, no un estado. */
export function proximo(a: Asignacion): string {
  if (a.estado === 'por retomar') return 'El próximo despertar se la da al siguiente que esté libre'
  if (a.trabajador === 'claude') return 'El próximo despertar sigue con ella y no toma otra'
  return `El próximo despertar la deja donde está si la rama ${a.rama ?? `${a.trabajador}/…`} se movió en los últimos ${INACTIVO_MIN} minutos; si no, la marca por retomar`
}

/** Una frase por issue asignada: quién, qué número, qué peso y qué hará el próximo despertar. */
export function frases(s: Salida, parada?: { parar: boolean; numero: number | null }, declarado?: Record<string, Declarado>): string[] {
  const salida: string[] = []
  for (const [clave, a] of Object.entries(s.asignaciones)) {
    const espera = declarado?.[clave]?.espera
    if (espera) {
      salida.push(`${NOMBRE[a.trabajador]} tiene la #${clave} (${a.clase}), peso ${a.peso}, pero espera al dueño: ${espera}. No lo ocupa: el control sigue con la siguiente de la cola.`)
      continue
    }
    const contra = a.contra ? `; ${NOMBRE[a.contra]} la revisa en sólo lectura` : a.sin_contra ? `; nadie libre para revisarla (${a.sin_contra})` : ''
    const retomar = a.estado === 'por retomar' ? ` Por retomar: ${a.motivo}.` : ''
    salida.push(`${NOMBRE[a.trabajador]} tiene la #${clave} (${a.clase}), peso ${a.peso}, esfuerzo ${a.esfuerzo}${contra}.${retomar} ${parada?.parar && parada.numero === Number(clave) ? 'El próximo despertar para: no le queda un paso que se pueda dar' : proximo(a)}.`)
  }
  if (salida.length === 0) salida.push('Nadie tiene una issue: no queda nada que se pueda asignar sin el dueño. El próximo despertar se detiene.')
  return salida
}

/**
 * La orden del próximo despertar de esta sesión: la issue que tiene, su primer paso sin hacer, el criterio y los
 * archivos (la primera de la cola que no espere al dueño). Sale del fichero y de nada más. El paso no se inventa: sin `declarado[n].pasos`, o con todos hechos,
 * la orden es parar. Es lo único que llega al modelo cuando el bucle despierta.
 */
export function orden(estado: Estado): { texto: string; parar: boolean; numero: number | null; paso: string | null } {
  // Las vigentes de esta sesión, en el orden de la cola (las claves numéricas de un objeto salen por número, no
  // por cola). La orden es la de la primera que no espere al dueño; si todas esperan, se para con el motivo.
  const cola = estado.cola ?? []
  const lugar = (n: string): number => (cola.indexOf(Number(n)) < 0 ? cola.length : cola.indexOf(Number(n)))
  const mias = Object.entries(estado.asignaciones ?? {})
    .filter(([, a]) => a.trabajador === 'claude' && a.estado === 'vigente')
    .sort(([a], [b]) => lugar(a) - lugar(b) || Number(a) - Number(b))
  const mia = mias.find(([n]) => !estado.declarado?.[n]?.espera) ?? mias[0]
  const cierre = 'No recorras el tablero ni abras issues: termina el bucle (ScheduleWakeup con stop) y dilo en una línea.'
  if (!mia) return { texto: `Orden: parar. Esta sesión no tiene una asignación vigente. ${cierre}`, parar: true, numero: null, paso: null }
  const numero = Number(mia[0])
  const d = estado.declarado?.[mia[0]]
  if (d?.espera) return { texto: `Orden: parar. La #${numero} espera al dueño: ${d.espera}. ${cierre}`, parar: true, numero, paso: null }
  const siguiente = (d?.pasos ?? []).find(x => !x.hecho)
  if (!siguiente) {
    const porque = d?.pasos?.length ? 'todos sus pasos están hechos' : 'no tiene pasos declarados (declarado.' + numero + '.pasos)'
    return { texto: `Orden: parar. La #${numero} es de esta sesión, pero ${porque} en .claude/orquestacion.json: no queda un paso que cierre algo. ${cierre}`, parar: true, numero, paso: null }
  }
  const noTocar = estado.no_tocar?.length ? estado.no_tocar : NO_TOCAR_INICIAL
  return {
    texto: [
      `Orden: issue #${numero}.`,
      `Siguiente paso: ${siguiente.paso}`,
      `Criterio: ${d?.criterio ?? `el que la issue #${numero} deja escrito`}`,
      `Archivos: ${d?.archivos?.length ? d.archivos.join(', ') : 'sólo los que este paso exija'}. No toques: ${noTocar.join('; ')}.`,
      'Haz sólo este paso. Al terminarlo, márcalo hecho en .claude/orquestacion.json; no lo des por hecho sin medirlo. Empujar, migrar y desplegar: sólo con la orden del dueño.',
    ].join('\n'),
    parar: false,
    numero,
    paso: siguiente.paso,
  }
}

/** Lo que no salió asignado, en una línea por situación. */
export function resto(s: Salida): string[] {
  const de = (sit: Fila['situacion']): string => s.filas.filter(f => f.situacion === sit).map(f => `#${f.numero}`).join(', ')
  const lineas: string[] = []
  if (de('en cola')) lineas.push(`En cola: ${de('en cola')}.`)
  if (de('espera al dueño')) lineas.push(`Espera al dueño: ${de('espera al dueño')}.`)
  if (de('partir')) lineas.push(`Hay que partir antes de asignar: ${de('partir')}.`)
  if (de('interina')) lineas.push(`Interinas, sin cerrar: ${de('interina')}.`)
  if (de('épica')) lineas.push(`Épicas: ${de('épica')}.`)
  return lineas
}

/** El mismo estado con la decisión nueva. No lleva la hora del router: sin cambio de decisión, el fichero no cambia. */
export function conDecision(estado: Estado, s: Salida, github: string, abiertas: number | null, pendientes: string[]): Estado {
  return {
    ...estado,
    cola: estado.cola?.length ? estado.cola : [...COLA_INICIAL],
    no_tocar: estado.no_tocar?.length ? estado.no_tocar : [...NO_TOCAR_INICIAL],
    asignaciones: s.asignaciones,
    clasificacion: s.filas,
    router: { github, issues_abiertas: abiertas, ...(pendientes.length ? { pendientes } : {}) },
  }
}
