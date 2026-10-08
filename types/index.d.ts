export type Conteo = {
  llamadas: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  usd: number
}

export type FilaModelo = Conteo & { modelo: string }

export type FilaTarea = {
  titulo: string
  veces: number
  llamadas: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  usd: number
  modelo: string
  /** Segundos desde la época del primer y último mensaje de la tarea, o null. */
  inicio: number | null
  fin: number | null
  minutos: number | null
  /** Solo en la tarea actual: minutos desde su última respuesta. */
  hace_min?: number | null
}

export type Despertador = {
  razon: string
  segundos: number | null
  parar: boolean
  noop: boolean
  cuando: number | null
  proximo?: number
  faltan_min?: number
}

export type Ritmo = {
  cubos_usd: number[]
  ancho_cubo_min: number
  usd_ultimos_30_min: number
  usd_por_hora: number
}

export type Resumen = {
  transcripcion: string
  /** La sesión acaba de abrirse y el motor aún no escribió la transcripción: el resumen va vacío. */
  sin_transcripcion?: boolean
  ahora: number
  inicio_sesion: number | null
  ultima_respuesta: number | null
  total: Conteo
  por_modelo: FilaModelo[]
  por_tarea: FilaTarea[]
  por_herramienta: Record<string, number>
  subagentes: string[]
  actual: FilaTarea | null
  despertador: Despertador | null
  ritmo: Ritmo
  nota_precios: string
}

export type Cobertura = {
  /** Porcentaje total de líneas cubiertas, o null si no hay dato. */
  total: number | null
  /** 'lista' | 'corriendo' | 'sin-dato' | 'no-aplica' | 'error' */
  estado: string
  /** Hora de la última medición o intento, en milisegundos. */
  cuando: number | null
  /** Última línea útil de la herramienta, recortada. */
  nota: string
}

export type Sesion = {
  /** Costo según el libro del propio motor (/cost), en USD; null si no lo da. */
  usdMotor: number | null
  /** Porcentaje del contexto ocupado, o null. */
  contextoPct: number | null
  /** Tokens del contexto en la última respuesta, o null. */
  contextoTokens: number | null
  /** Tamaño de la ventana de contexto en tokens, o null. */
  ventana: number | null
  /** Cuándo empezó la sesión, en milisegundos, o null. */
  inicio: number | null
  /** Hora de la última actualización, en milisegundos. */
  actualizado: number | null
  /** Error de la última actualización, o ''. */
  error: string
}

export type IssueGitHub = { number: number; title: string; labels: string[]; updatedAt: string }
export type PrGitHub = { number: number; title: string; isDraft: boolean; updatedAt: string }

export type GitHub = {
  repo: string
  cuando: number | null
  issues: IssueGitHub[]
  prs: PrGitHub[]
  error: string
}

export type SemanaAvance = {
  /** Lunes de la semana, AAAA-MM-DD (UTC). */
  lunes: string
  creadas: number
  /** Issues cerradas como hechas esa semana, sin contar las descartadas. */
  hechas: number
  descartadas: number
  /** Issues abiertas al terminar la semana. */
  abiertas_fin: number
  /** Parte de la factura mensual que el proyecto consumió esa semana, en USD. */
  usd_factura: number
  /** Porcentaje del consumo del proyecto en la ventana que cayó en esa semana. */
  pct_del_proyecto: number
}

export type ProyectoAvance = {
  /** Carpeta del proyecto en ~/.claude/projects, en minúsculas y con sus worktrees sumados. */
  clave: string
  sesiones: number
  prompts: number
  llamadas: number
  /** Parte del consumo de todos los proyectos de esta máquina, en porcentaje. */
  pct_del_total: number
  /** Esa parte aplicada a la factura mensual, en USD. */
  usd_factura: number
  pct_subagentes: number
  /** Porcentaje del consumo que es releer contexto (caché leída). */
  pct_relectura: number
  despertares: number
  /** Despertares del bucle que terminaron sin cambiar nada (noop). */
  despertares_vacios: number
  agentes: number
}

export type RepoAvance = {
  nombre: string
  /** Con qué cuenta de gh se leyó. */
  via: string
  error: string
  abiertas: number
  creadas: number
  hechas: number
  descartadas: number
  /** Parte de la factura del proyecto dividida entre las issues cerradas, o null si no hubo. */
  usd_por_issue: number | null
}

export type Avance = {
  /** 'sin-dato' | 'midiendo' | 'lista' | 'error' */
  estado: string
  /** Hora de la última medición o intento, en milisegundos. */
  cuando: number | null
  error: string
  /** Primer día de la ventana medida, AAAA-MM-DD, o ''. */
  desde: string
  /** Factura mensual sobre la que se reparte, en USD. */
  factura: number
  proyecto: ProyectoAvance | null
  repo: RepoAvance | null
  semanas: SemanaAvance[]
  reparto: { nombre: string; pct: number; usd: number }[]
}

/** La última decisión del control, en frases: quién tiene cada issue y qué hará el próximo despertar. */
export type Control = {
  cuando: number | null
  /** false: el repositorio de trabajo no tiene .claude/orquestacion.json y el control no decide en él. */
  activo: boolean
  /** «ok» o por qué no se pudieron leer las issues. */
  github: string
  /** Quién tiene tomado el candado de suites, o vacío. */
  candado: string
  frases: string[]
  resto: string[]
  avisos: string[]
  /** La orden del próximo despertar de esta sesión: issue, paso sin hacer, criterio y archivos; o parar. */
  orden: string
}

declare module 'claude-code' {
  interface PluginState {
    consumo: {
      avance: Avance
      resumen: Resumen | null
      cobertura: Cobertura
      sesion: Sesion
      github: GitHub
      control: Control
    }
  }
}
