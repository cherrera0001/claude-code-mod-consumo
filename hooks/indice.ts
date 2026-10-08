// El index de `consumo`, sin entrada ni salida: recibe lo ya leído y devuelve las fichas y sus páginas.
// Son dos salidas y las arman dos funciones distintas, a propósito:
//   · `paginaDeTareas` — el index privado: una ficha por repositorio del reparto, con número de issue, quién la
//     tiene, el paso sin hacer y qué hizo el último despertar. No lleva títulos de issues ni la cola.
//   · `fichaDeProduccion` — la ficha pública: recibe SÓLO { commit, bien, cuando }. No recibe el estado de
//     orquestación, así que no puede filtrar backlog aunque alguien se equivoque al llamarla.
// La página muestra la foto y nada más: HTML estático, sin guiones y sin estilos externos.

import type { Estado } from './router'
import { NOMBRE, orden } from './router'

/** Lo que el hook del despertar deja guardado, por raíz de repositorio, en el almacén del mod. */
export type Despertar = {
  /** Milisegundos de la época. */
  cuando: number
  resultado: 'orden' | 'parar'
  numero: number | null
  paso: string | null
  /** Pasos marcados `hecho` en todo el fichero cuando despertó. */
  pasosHechos: number
  /** Había más pasos hechos que en el despertar anterior. */
  cerro: boolean
}

export type Hizo = 'cerró algo' | 'dio una orden' | 'paró' | 'sin despertares registrados'

export type Ficha =
  | { nombre: string; control: false; estado: 'sin control'; foto: string }
  | {
      nombre: string
      control: true
      /** La issue en curso de esa sesión, o null si no tiene ninguna. */
      issue: number | null
      quien: string | null
      /** El primer paso sin hacer, o «no hay paso». */
      paso: string
      despertar: Hizo
      despertar_cuando: string | null
      foto: string
    }

export const SIN_PASO = 'no hay paso'

/** Hora legible y sin ambigüedad de zona: «2026-05-28 20:26 UTC». */
export function instante(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** Cuántos pasos hay marcados `hecho` en todo el fichero. Se cuenta el fichero entero para que cerrar el último
 * paso de una issue y pasar a la siguiente no parezca un retroceso. */
export function pasosHechos(estado: Estado): number {
  let n = 0
  for (const d of Object.values(estado.declarado ?? {})) n += (d?.pasos ?? []).filter(p => p?.hecho === true).length
  return n
}

/** El registro de un despertar, a partir del estado ya decidido y del registro anterior de esa misma raíz. */
export function registroDeDespertar(estado: Estado, anterior: Despertar | null, ahoraMs: number): Despertar {
  const o = orden(estado)
  const hechos = pasosHechos(estado)
  return {
    cuando: ahoraMs,
    resultado: o.parar ? 'parar' : 'orden',
    numero: o.numero,
    paso: o.paso,
    pasosHechos: hechos,
    cerro: anterior !== null && hechos > anterior.pasosHechos,
  }
}

/** Lo guardado puede venir de otra versión o estar a medias: sólo vale si tiene la forma entera. */
export function comoDespertar(x: unknown): Despertar | null {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (typeof d.cuando !== 'number' || typeof d.pasosHechos !== 'number' || (d.resultado !== 'orden' && d.resultado !== 'parar')) return null
  return {
    cuando: d.cuando,
    resultado: d.resultado,
    numero: typeof d.numero === 'number' ? d.numero : null,
    paso: typeof d.paso === 'string' ? d.paso : null,
    pasosHechos: d.pasosHechos,
    cerro: d.cerro === true,
  }
}

function queHizo(d: Despertar | null): Hizo {
  if (!d) return 'sin despertares registrados'
  if (d.cerro) return 'cerró algo'
  return d.resultado === 'orden' ? 'dio una orden' : 'paró'
}

/**
 * La ficha de un repositorio del reparto. `estado` es su .claude/orquestacion.json ya leído, o null si no lo
 * tiene: entonces sale «sin control» y nada más. Del estado sólo se toma el número de la issue en curso, quién
 * la tiene y el primer paso sin hacer; ni títulos, ni cola, ni clasificación.
 */
export function ficha(nombre: string, estado: Estado | null, despertar: Despertar | null, ahoraMs: number): Ficha {
  const foto = instante(ahoraMs)
  if (!estado) return { nombre, control: false, estado: 'sin control', foto }
  const numero = orden(estado).numero
  const asignacion = numero === null ? undefined : estado.asignaciones?.[String(numero)]
  const siguiente = numero === null ? undefined : (estado.declarado?.[String(numero)]?.pasos ?? []).find(p => !p.hecho)
  return {
    nombre,
    control: true,
    issue: numero,
    quien: asignacion ? NOMBRE[asignacion.trabajador] ?? String(asignacion.trabajador) : null,
    paso: siguiente?.paso ? String(siguiente.paso) : SIN_PASO,
    despertar: queHizo(despertar),
    despertar_cuando: despertar ? instante(despertar.cuando) : null,
    foto,
  }
}

const escapar = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CABEZA = (titulo: string): string =>
  `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapar(titulo)}</title>\n<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}section{border:1px solid;padding:0 1rem;margin:1rem 0}dt{font-weight:bold}dd{margin:0 0 .5rem 0}</style>\n</head>\n<body>\n`

function seccionDeFicha(f: Ficha): string {
  if (!f.control) return `<section>\n<h2>${escapar(f.nombre)}</h2>\n<p>sin control</p>\n</section>\n`
  const issue = f.issue === null ? 'ninguna en curso' : `#${f.issue}${f.quien ? ` · la tiene ${escapar(f.quien)}` : ''}`
  const despertar = `${f.despertar}${f.despertar_cuando ? ` (${f.despertar_cuando})` : ''}`
  return [
    '<section>',
    `<h2>${escapar(f.nombre)}</h2>`,
    '<dl>',
    `<dt>Issue en curso</dt><dd>${issue}</dd>`,
    `<dt>Paso sin hacer</dt><dd>${escapar(f.paso)}</dd>`,
    `<dt>Último despertar</dt><dd>${escapar(despertar)}</dd>`,
    `<dt>Foto</dt><dd>${f.foto}</dd>`,
    '</dl>',
    '</section>',
    '',
  ].join('\n')
}

/** El index de tareas, privado: la página y su JSON. Se queda en la máquina; lleva números de issue y pasos. */
export function paginaDeTareas(fichas: Ficha[], ahoraMs: number): { html: string; json: string } {
  const foto = instante(ahoraMs)
  const html =
    CABEZA('Index de tareas') +
    `<h1>Index de tareas</h1>\n<p>Foto del ${foto}. Privado: no se publica. Muestra, no decide: quien asigna y da la orden es el control.</p>\n` +
    (fichas.length ? fichas.map(seccionDeFicha).join('') : '<p>Ningún repositorio entra en el reparto todavía.</p>\n') +
    '</body>\n</html>\n'
  return { html, json: `${JSON.stringify({ foto, fichas }, null, 2)}\n` }
}

/** Lo único que la ficha pública conoce: lo que la URL de salud publica, y la hora de la foto. */
export type Salud = { commit: string | null; bien: boolean; cuando: number }

/**
 * Lee lo que respondió la URL de salud. `commit`: el campo `commit` si es un SHA (hexadecimal de 7 a 40); cualquier
 * otra cosa es null y no se refleja. `bien`: `status` o `estado` dicen «ok», o `ok` es true. Una respuesta vacía,
 * que no es JSON o que no dice nada de eso, no está bien.
 */
export function saludDe(respuesta: string): { commit: string | null; bien: boolean } {
  let d: Record<string, unknown>
  try {
    const leido = JSON.parse(respuesta) as unknown
    if (!leido || typeof leido !== 'object') return { commit: null, bien: false }
    d = leido as Record<string, unknown>
  } catch {
    return { commit: null, bien: false }
  }
  const commit = typeof d.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(d.commit) ? d.commit.toLowerCase() : null
  const dicho = [d.status, d.estado].find(x => typeof x === 'string') as string | undefined
  return { commit, bien: d.ok === true || (dicho ?? '').trim().toLowerCase() === 'ok' }
}

/**
 * La ficha de producción, pública: commit publicado, salud y hora. Se puede copiar a un sitio público porque no
 * recibe nada más: ni issues, ni pasos, ni nombres, ni cola.
 */
export function fichaDeProduccion(s: Salud): { html: string; json: string } {
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

/** El nombre de un proyecto, reducido a lo que cabe sin riesgo en un nombre de archivo. */
export function nombreDeArchivo(nombre: string): string {
  return (
    nombre
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'proyecto'
  )
}

/** Sólo http(s): la URL va a `curl` como argumento y no puede parecer una opción. */
export function urlDeSalud(estado: Estado | null): string | null {
  const url = estado?.produccion?.salud
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) ? url : null
}
