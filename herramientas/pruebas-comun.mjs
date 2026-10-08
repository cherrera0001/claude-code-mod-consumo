// Lo que comparten las pruebas del guion y del instalador: repositorios temporales con un remoto local desnudo.
// Nada de esto toca un repositorio real ni la carpeta del usuario.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const barras = ruta => String(ruta).replace(/\\/g, '/').replace(/\/+$/, '')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'consumo-pruebas-'))
const configVacia = path.join(base, 'gitconfig-vacio')
fs.writeFileSync(configVacia, '')

/** El entorno de git de las pruebas: sin la configuración de la máquina (plantillas, hooks globales, firma). */
export function entorno() {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (/^GIT_/i.test(k)) delete e[k]
  return {
    ...e,
    GIT_CONFIG_GLOBAL: configVacia,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Prueba',
    GIT_AUTHOR_EMAIL: 'prueba@ejemplo.invalid',
    GIT_COMMITTER_NAME: 'Prueba',
    GIT_COMMITTER_EMAIL: 'prueba@ejemplo.invalid',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env: entorno(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

export function escribir(raiz, relativa, texto) {
  const ruta = path.join(raiz, relativa)
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  fs.writeFileSync(ruta, texto)
  return ruta
}

export function confirmar(arbol, relativa, texto, mensaje = `añade ${relativa}`) {
  escribir(arbol, relativa, texto)
  git(arbol, 'add', '--', relativa)
  git(arbol, 'commit', '-q', '-m', mensaje)
}

export function carpetaTemporal(prefijo = 'c') {
  return barras(fs.mkdtempSync(path.join(base, `${prefijo}-`)))
}

/**
 * Un repositorio con remoto desnudo y dos árboles de agentes: <dir>/plataforma (main), <dir>/plataforma-agy
 * (rama agy/12) y <dir>/plataforma-codex (rama codex/34). Todo empujado y limpio.
 */
export function escenario(opciones = {}) {
  const dir = carpetaTemporal('esc')
  const remoto = `${dir}/origen.git`
  const raiz = `${dir}/plataforma`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto], { env: entorno(), stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['init', '-q', '-b', 'main', raiz], { env: entorno(), stdio: 'ignore', windowsHide: true })
  escribir(raiz, 'db/migrations/0001_base.sql', '-- base\n')
  escribir(raiz, 'LEEME.txt', 'plataforma\n')
  if (opciones.estado) escribir(raiz, '.claude/orquestacion.json', `${JSON.stringify(opciones.estado, null, 2)}\n`)
  escribir(raiz, '.gitignore', '.claude/orquestacion.local.json\n.env\n')
  git(raiz, 'add', '-A')
  git(raiz, 'commit', '-q', '-m', 'primer commit')
  git(raiz, 'remote', 'add', 'origin', remoto)
  git(raiz, 'push', '-q', '-u', 'origin', 'main')
  const agy = `${dir}/plataforma-agy`
  const codex = `${dir}/plataforma-codex`
  if (!opciones.sinArboles) {
    git(raiz, 'worktree', 'add', '-q', '-b', 'agy/12', agy)
    git(raiz, 'worktree', 'add', '-q', '-b', 'codex/34', codex)
  }
  return { dir, remoto, raiz, agy, codex, salida: carpetaTemporal('salida') }
}

/** Otro clon empuja a main: el remoto se mueve sin que el repositorio de la prueba se entere. */
export function moverRemoto(e, relativa = 'otro.txt') {
  const clon = `${e.dir}/otro-clon-${Math.random().toString(36).slice(2, 7)}`
  execFileSync('git', ['clone', '-q', e.remoto, clon], { env: entorno(), stdio: 'ignore', windowsHide: true })
  confirmar(clon, relativa, 'de otro\n')
  git(clon, 'push', '-q', 'origin', 'main')
}

export const MINUTO = 60_000

export function limpiar() {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
