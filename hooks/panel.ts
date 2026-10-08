// Lo que el panel y el control leen del index, sin entrada ni salida: recibe index.json y diario.json ya leídos
// (los escribe el guion sin modelo, herramientas/indice.mjs y diario.mjs) y devuelve las líneas del panel y las
// señales para el control. El mod no vuelve a calcular nada de esto: una sola fuente de verdad. Si la foto es
// vieja, no se muestra nada como vigente y el control no recibe señales.

import type { Lectura } from '../types'
import type { Senal } from './router'

export const MIN_FOTO_VIEJA = 10
export const MEDIAS_A_LA_VISTA = 5
const MIN = 60_000

type Dato = Record<string, any>

export function hace(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return 'un tiempo sin medir'
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  return `${Math.floor(m / 1440)} días`
}

const p2 = (n: number): string => String(n).padStart(2, '0')
/** La hora local, «14:05»; con la fecha delante si no es de hoy. */
export function horaLocal(ms: number, ahoraMs: number): string {
  const d = new Date(ms)
  const hoy = new Date(ahoraMs)
  const hora = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  return d.toDateString() === hoy.toDateString() ? hora : `${p2(d.getDate())}-${p2(d.getMonth() + 1)} ${hora}`
}

/** Dos cifras significativas y coma decimal: «2,0 d», «7,5 d», «25 d», «40 min». */
export function enDias(dias: number): string {
  const dos = (x: number): number => Number(x.toPrecision(2))
  if (dias < 1 / 24) return `${Math.round(dias * 24 * 60)} min`
  const [valor, unidad] = dias < 1 ? [dos(dias * 24), 'h'] : [dos(dias), 'd']
  return `${valor < 10 ? valor.toFixed(1).replace('.', ',') : String(Math.round(valor))} ${unidad}`
}

const barras = (ruta: string): string => ruta.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** El repositorio del index que corresponde a la carpeta de esta sesión: su raíz, uno de sus árboles o una carpeta de dentro. */
function repositorioDe(index: Dato, raiz: string): Dato | null {
  const aqui = barras(raiz)
  for (const r of Array.isArray(index.repositorios) ? index.repositorios : []) {
    if (!r || r.error || typeof r.raiz !== 'string') continue
    const suya = barras(r.raiz)
    const arboles = [...(Array.isArray(r.arboles) ? r.arboles : []), ...(Array.isArray(r.efimeros?.inactivos) ? r.efimeros.inactivos : [])]
    if (aqui === suya || aqui.startsWith(`${suya}/`) || arboles.some(a => typeof a?.ruta === 'string' && barras(a.ruta) === aqui)) return r
  }
  return null
}

const VACIA: Lectura = { instalado: false, vigente: false, foto_ms: null, repositorio: null, senales: [], abiertas: null, fuera: [], caducadas: [], construidas: null, primera_alta: null, foto: '', vieja: '', cuellos: [], cuellos_resto: '', quien_titulo: '', quien: [], declarado: [], flujo: [], coordinacion: [] }

/**
 * Lee la foto. `index` y `diario`: los JSON ya leídos, o null si no están. `raiz`: la carpeta de la sesión.
 * Con la foto vieja (más de 10 minutos) devuelve sólo el aviso: ni cuellos, ni señales, ni cifras.
 */
export function leerFoto(index: unknown, diario: unknown, raiz: string, ahoraMs: number): Lectura {
  if (!index || typeof index !== 'object') return VACIA
  const x = index as Dato
  const fotoMs = typeof x.foto_ms === 'number' ? x.foto_ms : null
  if (fotoMs === null) return VACIA
  const edad = (ahoraMs - fotoMs) / MIN
  const repo = repositorioDe(x, raiz)
  const nombre = repo ? String(repo.nombre) : null
  const base: Lectura = { ...VACIA, instalado: true, foto_ms: fotoMs, repositorio: nombre }
  if (edad > MIN_FOTO_VIEJA) {
    return { ...base, vieja: `El index no se está actualizando: la última foto es de las ${horaLocal(fotoMs, ahoraMs)}, hace ${hace(edad)}. Nada de lo que medía se muestra como vigente.` }
  }
  const foto = `Foto de las ${horaLocal(fotoMs, ahoraMs)} · hace ${edad < 1.5 ? `${Math.max(0, Math.round(edad * 60))} s` : hace(edad)} · ${nombre ?? 'esta carpeta no está entre los repositorios del index'}`
  if (!repo) return { ...base, vigente: true, foto, vieja: 'Esta carpeta no está entre los repositorios que mide el index: «node herramientas/instalar.mjs --raiz <este repositorio>» la añade.' }

  // Cuellos de botella de este repositorio: los de gravedad alta, todos; los de media, hasta cinco; el resto, contado.
  const suyos = (Array.isArray(x.cuellos) ? x.cuellos : []).filter((c: Dato) => c && c.repositorio === repo.nombre && typeof c.que === 'string')
  const senales: Senal[] = suyos.map((c: Dato) => ({ tipo: String(c.tipo), gravedad: c.gravedad === 'alta' ? 'alta' : 'media', que: String(c.que), desde: typeof c.desde === 'string' ? c.desde : undefined, datos: c.datos && typeof c.datos === 'object' ? c.datos : {} }))
  const altas = senales.filter(s => s.gravedad === 'alta')
  const medias = senales.filter(s => s.gravedad === 'media')
  const cuellos = [...altas.map(s => ({ gravedad: 'ALTA', texto: s.que })), ...medias.slice(0, MEDIAS_A_LA_VISTA).map(s => ({ gravedad: 'MEDIA', texto: s.que }))]
  const sobran = medias.length - Math.min(medias.length, MEDIAS_A_LA_VISTA)

  // Quién está en qué, medido: una línea por árbol con trabajo vivo.
  const arboles: Dato[] = Array.isArray(repo.arboles) ? repo.arboles : []
  const vivos = arboles.filter(a => typeof a.estado === 'string' && !a.estado.startsWith('sin cambios locales') && !a.estado.startsWith('la carpeta'))
  const quien = vivos.map(a => {
    const sucio = a.sin_confirmar ? `${a.sin_confirmar} ${a.sin_confirmar === 1 ? 'fichero' : 'ficheros'} sin confirmar${a.mas_reciente ? `, el más reciente hace ${hace((ahoraMs - a.mas_reciente.ms) / MIN)}` : ''}` : '0 ficheros sin confirmar'
    return `${a.forma ?? ''} ${a.estado} · ${a.principal ? 'sesión principal' : a.trabajador ?? (a.efimero ? 'agente efímero' : 'trabajador sin identificar')} · ${a.issue === null || a.issue === undefined ? 'sin issue en la rama' : `#${a.issue}`} · ${a.rama ?? 'HEAD suelto'} · ${sucio} · ${a.delante === null || a.delante === undefined ? 'por delante: NO MEDIDO' : `${a.delante} ${a.delante === 1 ? 'commit' : 'commits'} por delante`}`.trim()
  })

  // Lo declarado que lo medido contradice: no se muestra como vigente, se marca.
  const g: Dato = repo.github ?? {}
  const abiertas: number[] | null = Array.isArray(g.abiertas_numeros) ? g.abiertas_numeros : null
  const control: Dato = repo.control ?? {}
  const fuera: string[] = Array.isArray(control.fuera) ? control.fuera.map(String) : []
  const enEsperaCaducada = new Set<number>(Array.isArray(control.esperas_caducadas) ? control.esperas_caducadas : [])
  const caducadas: number[] = []
  const declarado: string[] = []
  for (const a of Array.isArray(control.asignaciones) ? control.asignaciones : []) {
    const quienEs = String(a.quien ?? a.trabajador)
    if (abiertas && !abiertas.includes(a.issue)) {
      caducadas.push(a.issue)
      declarado.push(`declarado, caducado: la #${a.issue} figura en manos de ${quienEs} y ya no está abierta en GitHub`)
    } else if (fuera.includes(String(a.trabajador))) {
      caducadas.push(a.issue)
      declarado.push(`declarado, caducado: la #${a.issue} figura en manos de ${quienEs}, que está fuera`)
    } else if (enEsperaCaducada.has(a.issue)) {
      declarado.push(`declarado, caducado: la #${a.issue} figura en espera y su rama ya llegó a la principal`)
    }
  }

  // Flujo, con indicadores reales. Lo que falta, NO MEDIDO con su motivo.
  const motivoGitHub = x.sin_red === true ? 'la foto se tomó sin red' : g.credencial?.estado === 'sin declarar' ? 'el repositorio no declara credencial de GitHub' : g.credencial?.estado === 'rechazada (401)' ? 'GitHub rechazó la credencial (401)' : (g.credencial?.nota ?? 'GitHub no respondió')
  const flujo: string[] = []
  if (Number.isInteger(g.issues_abiertas)) {
    const b = g.no_avanzan
    flujo.push(`Issues abiertas: ${g.issues_abiertas}${b ? `; ${b.total} de ${b.denominador} no pueden avanzar solas (${b.espera} por espera declarada, ${b.etiqueta} por etiqueta de bloqueo, ${b.xl} de peso XL sin partir)` : ''} · cerradas hoy: ${Number.isInteger(g.cerradas_hoy) ? g.cerradas_hoy : 'NO MEDIDO'} · GitHub, en esta foto`)
  } else flujo.push(`Issues abiertas y cerradas hoy: NO MEDIDO (${motivoGitHub})`)
  const d: Dato | null = diario && typeof diario === 'object' ? ((diario as Dato).repositorios?.[barras(String(repo.raiz))] ?? null) : null
  const calculado = typeof (diario as Dato | null)?.calculado_ms === 'number' ? `cálculo diario de las ${horaLocal((diario as Dato).calculado_ms, ahoraMs)}` : 'cálculo diario'
  const sinDiario = d?.motivo ?? (g.credencial?.estado === 'sin declarar' ? 'el repositorio no declara credencial de GitHub, y el cálculo diario la necesita' : 'el cálculo diario todavía no se hizo: «node indice.mjs --diario»')
  if (d?.medido) {
    const e = d.entrega
    flujo.push(e.p50_dias === null ? `Tiempo de entrega: NO MEDIDO (n = ${e.n} issues construidas, hacen falta 10 para una mediana)` : `Tiempo de entrega: la mitad de las construidas, menos de ${enDias(e.p50_dias)}${e.p85_dias === null ? '; P85 NO MEDIDO (hacen falta 20)' : `; 85 de cada 100, menos de ${enDias(e.p85_dias)}`} · n = ${e.n} issues construidas · ${calculado}`)
  } else flujo.push(`Tiempo de entrega: NO MEDIDO (${sinDiario})`)
  const integ: Dato = repo.integracion ?? {}
  if (integ.medido) {
    const s = integ.sin_integrar
    flujo.push(`Sin integrar: ${s.total} ${s.total === 1 ? 'commit escrito' : 'commits escritos'} y sin llegar a ${repo.origen?.rama ?? 'la principal'}${s.de_hoy ? `; ${s.de_hoy} de hoy, el más viejo de hoy hace ${hace((ahoraMs - s.mas_viejo_de_hoy_ms) / MIN)}` : '; 0 de hoy'} · n = ${s.ramas_miradas} ramas miradas`)
    const u = integ.umbral ?? {}
    const umbral = u.p95_min === null || u.p95_min === undefined ? `P95 NO MEDIDO (n = ${u.n ?? 0} huecos, hacen falta 40)` : `P95 = ${u.p95_min} min, n = ${u.n}`
    flujo.push(integ.hueco_min === null || integ.hueco_min === undefined ? `Hueco desde el último empuje: sin commits de hoy esperando, no hay hueco que medir · ${umbral}` : `Hueco desde el último empuje: ${hace(integ.hueco_min)}${integ.sobre_el_umbral ? ', MAYOR que lo habitual' : ''} · ${umbral}`)
  } else flujo.push('Sin integrar y hueco de empujes: NO MEDIDO (este clon no tiene rama principal remota)')
  flujo.push(d?.medido ? `Cierres en bloque: ${d.bloques.cierres_en_bloque} de ${d.bloques.cierres} cierres, en ${d.bloques.bloques} ${d.bloques.bloques === 1 ? 'bloque' : 'bloques'} · ${calculado}` : `Cierres en bloque: NO MEDIDO (${sinDiario})`)

  // Coordinación.
  const k: Dato | null = repo.incidentes ?? null
  const coordinacion = [k ? `Incidentes de hoy: ${k.hoy}${k.hoy ? `; ${k.en_causa_repetida} de ${k.hoy} son de una causa que se repite` : ''} · n = ${k.dias_con_registro} ${k.dias_con_registro === 1 ? 'día' : 'días'} de registro` : 'Incidentes de hoy: NO MEDIDO (el repositorio no tiene registro de incidentes)']
  const dec: Dato | null = (diario as Dato | null)?.decisiones ?? null
  if (dec && dec.cambios > 0) coordinacion.push(`Señales que cambiaron la orden: ${dec.senales} (${dec.altas} de gravedad alta); resueltas ${dec.resueltas}; reaparecieron ${dec.reaparecidas} · ${dec.dias >= 7 ? `${dec.dias} días de registro` : `tendencia NO MEDIDO (n = ${dec.dias} días de registro, hacen falta 7): sólo conteo`}`)

  // Una foto escrita por un guion anterior no trae el estado de cada árbol ni los datos de las señales: se dice.
  const version = String(x.version ?? '')
  const antigua = /^(2\.(3|[4-9]|\d\d)\.|[3-9]\.|\d\d)/.test(version) ? '' : `La foto la escribió el guion ${version || 'de una versión anterior'} y este panel necesita la 2.3.0 o posterior: vuelve a correr «node herramientas/instalar.mjs --raiz <este repositorio>» para actualizarlo. Hasta entonces faltan el estado de cada árbol y las señales del control.`

  return {
    ...base,
    vigente: true,
    vieja: antigua,
    senales,
    abiertas,
    fuera,
    caducadas,
    construidas: d?.medido ? d.entrega.n : null,
    primera_alta: d?.medido ? String(d.universo.primera_alta) : null,
    foto,
    cuellos,
    cuellos_resto: sobran > 0 ? `y ${sobran} más de gravedad media, en el index` : '',
    quien_titulo: `Quién está en qué, medido · ${vivos.length} de ${arboles.length} árboles con trabajo vivo`,
    quien,
    declarado,
    flujo,
    coordinacion,
  }
}

/** «≈ X USD por issue construida», con una cifra significativa y lo que entra arriba y abajo. Con menos de 30, NO MEDIDO. */
export function costoPorConstruida(usdDelProyecto: number | null, desde: string, l: Lectura): string {
  if (usdDelProyecto === null) return ''
  if (l.construidas === null) return 'Costo por issue construida: NO MEDIDO (falta el cálculo diario, que cuenta las issues con algún commit que las nombra)'
  if (l.construidas < 30) return `Costo por issue construida: NO MEDIDO (n = ${l.construidas} issues construidas, hacen falta 30)`
  const una = Number((usdDelProyecto / l.construidas).toPrecision(1))
  return `≈ ${String(una).replace('.', ',')} USD por issue construida, acumulado (≈ ${Math.round(usdDelProyecto)} USD de la factura repartidos a este proyecto${desde ? ` desde el ${desde}` : ''} ÷ ${l.construidas} issues construidas${l.primera_alta ? ` desde el ${l.primera_alta}` : ''}). Subestima: sólo cuenta a Claude, no a los otros agentes`
}
