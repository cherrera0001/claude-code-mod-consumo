import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Avance, Cobertura, Control, GitHub, Resumen, Sesion } from '../types'
import { COLA_INICIAL, EXTERNOS, TRABAJADORES, arbol, clasificar, conDecision, enrutar, frases, orden, pesar, resto, tabla } from './router'
import type { Actividad, Asignacion, Estado, Issue, Salida, Trabajador } from './router'

// consumo 2.0 mide, gestiona y controla. Mide como antes. Gestiona la cola y quién tiene cada issue. Controla:
// en session.start y en cada despertar del bucle asigna, reasigna o se detiene, y lo escribe en
// .claude/orquestacion.json del repositorio de trabajo antes de que nadie empiece (la decisión vive en router.ts).
// La parte que mide se lee como el indicador de combustible de un vehículo: cuánto tanque de contexto
// queda, cuánto presupuesto va gastado, a qué ritmo se gasta y cuánta autonomía da; qué tarea se está
// construyendo, qué espera el bucle y qué queda pendiente en GitHub. Solo lee; ejecuta el resumidor en
// Python (embebido abajo, por stdin), `gh` para GitHub y, a pedido, pytest con cobertura.

const PANE = 'consumo'
// Se piden hasta TOPE_GITHUB issues y PR para poder decir cuántos hay; en el tablero caben los primeros.
const TOPE_GITHUB = 200
const VISIBLES_GITHUB = 8

function cuantos(n: number): string {
  return n >= TOPE_GITHUB ? `${n}+` : String(n)
}

const resumen = atom({ plugin: 'consumo', key: 'resumen' } as const, null as Resumen | null)
const cobertura = atom({ plugin: 'consumo', key: 'cobertura' } as const, {
  total: null,
  estado: 'sin-dato',
  cuando: null,
  nota: '',
} as Cobertura)
const sesion = atom({ plugin: 'consumo', key: 'sesion' } as const, {
  usdMotor: null,
  contextoPct: null,
  contextoTokens: null,
  ventana: null,
  inicio: null,
  actualizado: null,
  error: '',
} as Sesion)
const github = atom({ plugin: 'consumo', key: 'github' } as const, {
  repo: '',
  cuando: null,
  issues: [],
  prs: [],
  error: '',
} as GitHub)
// Avance real: issues del repositorio cerradas por semana y parte de la factura mensual que consume el proyecto.
const avance = atom({ plugin: 'consumo', key: 'avance' } as const, {
  estado: 'sin-dato',
  cuando: null,
  error: '',
  desde: '',
  factura: 0,
  proyecto: null,
  repo: null,
  semanas: [],
  reparto: [],
} as Avance)

// El control: la última decisión del router, en frases. Es lo que pinta la tercera pregunta del panel y lo
// que el prompt de sistema le repite a quien despierta.
const control = atom({ plugin: 'consumo', key: 'control' } as const, {
  cuando: null,
  activo: false,
  github: '',
  candado: '',
  frases: [],
  resto: [],
  avisos: [],
  orden: '',
} as Control)

// El resumidor, tal cual está en hooks/resumen_transcripcion.py; se ejecuta por stdin porque el módulo
// no conoce su propia carpeta (`options` trae solo la configuración del usuario).
const RESUMIDOR = `
from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PRECIOS = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
CAMPOS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
MINUTOS_RITMO = 60
ANCHO_CUBO = 5


def precio(modelo):
    for clave, par in PRECIOS.items():
        if modelo.startswith(clave):
            return par
    return (4.0, 20.0)


def usd(modelo, c):
    entrada, salida = precio(modelo)
    return (c["input_tokens"] * entrada + c["output_tokens"] * salida
            + c["cache_read_input_tokens"] * entrada * 0.1 + c["cache_creation_input_tokens"] * entrada * 1.25) / 1e6


def vacio():
    return {k: 0 for k in CAMPOS} | {"llamadas": 0}


def sumar(destino, u):
    for k in CAMPOS:
        destino[k] += int(u.get(k) or 0)
    destino["llamadas"] += 1


def instante(r):
    t = r.get("timestamp")
    if not isinstance(t, str):
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def titulo_de(contenido):
    if isinstance(contenido, str):
        texto = contenido
    elif isinstance(contenido, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in contenido):
            return None
        texto = " ".join(b.get("text", "") for b in contenido if isinstance(b, dict) and b.get("type") == "text")
    else:
        return None
    texto = " ".join(texto.split())
    if not texto or texto.startswith("<"):
        return None
    return texto[:70]


class Lectura:
    def __init__(self):
        self.por_modelo = {}
        self.tareas = {}
        self.orden = []
        self.herramientas = {}
        self.respuestas = []
        self.despertador = None
        self.ultimo_instante = None
        self.primer_instante = None

    def tarea(self, titulo, inicio):
        if titulo not in self.tareas:
            self.tareas[titulo] = vacio() | {"veces": 0, "usd": 0.0, "modelos": {}, "inicio": inicio, "fin": inicio}
            self.orden.append(titulo)
        return self.tareas[titulo]

    def leer(self, ruta, etiqueta):
        actual = etiqueta
        encontradas = 0
        mensajes = {}
        bloques = set()
        if etiqueta is not None:
            self.tarea(etiqueta, None)["veces"] += 1
        with open(ruta, encoding="utf-8", errors="replace") as f:
            for linea in f:
                try:
                    r = json.loads(linea)
                except Exception:
                    continue
                tipo = r.get("type")
                m = r.get("message") or {}
                t_r = instante(r)
                if tipo == "user" and etiqueta is None and not r.get("isMeta"):
                    t = titulo_de(m.get("content"))
                    if t:
                        actual = t
                        fila = self.tarea(t, t_r)
                        fila["veces"] += 1
                        if fila["inicio"] is None:
                            fila["inicio"] = t_r
                    continue
                if tipo != "assistant":
                    continue
                u = m.get("usage") or {}
                modelo = m.get("model") or "?"
                if u:
                    # Un mismo mensaje sale en varias lineas (una por bloque) y todas repiten su uso:
                    # se cuenta una vez, con el ultimo valor, en la tarea donde empezo.
                    clave = m.get("id") or r.get("uuid")
                    previo = mensajes.get(clave)
                    mensajes[clave] = (modelo, u, t_r if t_r is not None else (previo[2] if previo else None),
                                       previo[3] if previo else actual)
                for b in m.get("content") or []:
                    if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                        continue
                    if b.get("id") in bloques:
                        continue
                    bloques.add(b.get("id"))
                    nombre = str(b.get("name"))
                    self.herramientas[nombre] = self.herramientas.get(nombre, 0) + 1
                    if nombre == "ScheduleWakeup" and etiqueta is None and isinstance(b.get("input"), dict):
                        e = b["input"]
                        self.despertador = {"razon": str(e.get("reason") or "")[:120], "segundos": e.get("delaySeconds"),
                                            "parar": bool(e.get("stop")), "noop": bool(e.get("noop")), "cuando": t_r}
        for modelo, u, t_r, tarea in mensajes.values():
            encontradas += 1
            conteo = {k: int(u.get(k) or 0) for k in CAMPOS}
            self.por_modelo.setdefault(modelo, vacio())
            sumar(self.por_modelo[modelo], u)
            costo = usd(modelo, conteo)
            if t_r is not None:
                self.respuestas.append((t_r, costo))
                self.ultimo_instante = max(self.ultimo_instante or t_r, t_r)
                self.primer_instante = min(self.primer_instante or t_r, t_r)
            if tarea is not None:
                fila = self.tarea(tarea, t_r)
                sumar(fila, u)
                fila["usd"] += costo
                fila["modelos"][modelo] = fila["modelos"].get(modelo, 0) + 1
                if t_r is not None:
                    fila["fin"] = max(fila["fin"] or t_r, t_r)
        return encontradas


def rutas_de_la_sesion(sesion, cwd):
    codificada = "".join(c if (c.isascii() and c.isalnum()) else "-" for c in cwd)
    base = os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".claude", "projects", codificada)
    return os.path.join(base, sesion + ".jsonl"), os.path.join(base, sesion, "subagents")


def etiqueta_de_subagente(ruta):
    nombre = os.path.basename(ruta)
    ident = nombre.replace("agent-", "").replace(".jsonl", "")[:8]
    meta = ruta[:-len(".jsonl")] + ".meta.json"
    try:
        m = json.load(open(meta, encoding="utf-8"))
        for clave in ("description", "agentType", "subagent_type", "name"):
            if isinstance(m.get(clave), str) and m[clave].strip():
                return "subagente " + " ".join(m[clave].split())[:40] + " (" + ident + ")"
    except Exception:
        pass
    return "subagente " + ident


def ritmo(respuestas, ahora):
    cubos = [0.0] * (MINUTOS_RITMO // ANCHO_CUBO)
    ultimos_30 = 0.0
    for t, costo in respuestas:
        hace = ahora - t
        if hace < 0 or hace >= MINUTOS_RITMO * 60:
            continue
        cubos[len(cubos) - 1 - int(hace // (ANCHO_CUBO * 60))] += costo
        if hace < 1800:
            ultimos_30 += costo
    return {"cubos_usd": [round(c, 2) for c in cubos], "ancho_cubo_min": ANCHO_CUBO,
            "usd_ultimos_30_min": round(ultimos_30, 2), "usd_por_hora": round(ultimos_30 * 2, 2)}


def main():
    sesion = sys.argv[sys.argv.index("--sesion") + 1]
    cwd = sys.argv[sys.argv.index("--cwd") + 1]
    transcripcion, carpeta_sub = rutas_de_la_sesion(sesion, cwd)
    # Una sesion recien abierta aun no tiene transcripcion: no es un error, es un resumen vacio.
    hay = os.path.exists(transcripcion)
    lectura = Lectura()
    if hay:
        lectura.leer(transcripcion, None)
    subagentes = []
    if os.path.isdir(carpeta_sub):
        for ruta in sorted(glob.glob(os.path.join(carpeta_sub, "agent-*.jsonl"))):
            etiqueta = etiqueta_de_subagente(ruta)
            if lectura.leer(ruta, etiqueta) > 0:
                subagentes.append(etiqueta)
            else:
                lectura.tareas.pop(etiqueta, None)
                lectura.orden.remove(etiqueta)
    ahora = datetime.now(timezone.utc).timestamp()
    filas_modelo = [{"modelo": modelo, **c, "usd": round(usd(modelo, c), 2)} for modelo, c in lectura.por_modelo.items()]
    filas_tarea = []
    for t in lectura.orden:
        c = lectura.tareas[t]
        filas_tarea.append({
            "titulo": t, "veces": c["veces"], "llamadas": c["llamadas"], "output_tokens": c["output_tokens"],
            "cache_read_input_tokens": c["cache_read_input_tokens"], "cache_creation_input_tokens": c["cache_creation_input_tokens"],
            "usd": round(c["usd"], 2), "modelo": max(c["modelos"], key=c["modelos"].get) if c["modelos"] else "?",
            "inicio": c["inicio"], "fin": c["fin"],
            "minutos": round((c["fin"] - c["inicio"]) / 60, 1) if c["inicio"] and c["fin"] else None,
        })
    total = vacio()
    for c in lectura.por_modelo.values():
        for k in CAMPOS:
            total[k] += c[k]
        total["llamadas"] += c["llamadas"]
    principales = [f for f in filas_tarea if not f["titulo"].startswith("subagente ")]
    actual = principales[-1] if principales else None
    if actual is not None:
        actual = dict(actual, hace_min=round((ahora - actual["fin"]) / 60, 1) if actual["fin"] else None)
    desp = lectura.despertador
    if desp and desp.get("cuando") and isinstance(desp.get("segundos"), (int, float)):
        proximo = desp["cuando"] + float(desp["segundos"])
        desp = dict(desp, proximo=proximo, faltan_min=round((proximo - ahora) / 60, 1))
    salida = {
        "transcripcion": os.path.basename(transcripcion),
        "sin_transcripcion": not hay,
        "ahora": ahora,
        "inicio_sesion": lectura.primer_instante,
        "ultima_respuesta": lectura.ultimo_instante,
        "total": total | {"usd": round(sum(f["usd"] for f in filas_modelo), 2)},
        "por_modelo": filas_modelo,
        "por_tarea": filas_tarea,
        "por_herramienta": dict(sorted(lectura.herramientas.items(), key=lambda kv: -kv[1])),
        "subagentes": subagentes,
        "actual": actual,
        "despertador": desp,
        "ritmo": ritmo(lectura.respuestas, ahora),
        "nota_precios": "precio de lista; cache leida 0,1 y escrita 1,25 de la entrada (cache de 5 min)",
    }
    print(json.dumps(salida, ensure_ascii=False))


main()
`

// La medición de avance, tal cual está en hooks/avance_proyecto.py; por stdin, por la misma razón.
const AVANCE_PY = `
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Avance real de un proyecto: que parte del consumo de Claude Code se lleva (para repartir la factura
# mensual) y cuantas issues de su repositorio se cerraron con el. Solo lee: transcripciones locales y gh.
# Fuente en ASCII y sin barras invertidas: va embebido en el modulo y entra por stdin.

# Peso por millon de tokens (entrada, salida). Sirve para REPARTIR la factura entre proyectos; no es un precio.
PESOS = (("fable", 10.0, 50.0), ("opus", 4.0, 20.0), ("sonnet", 2.0, 10.0), ("haiku", 1.0, 5.0))
CADUCA_S = 20 * 60
FORMATO = "%Y-%m-%dT%H:%M:%S"


def arg(nombre, defecto=""):
    return sys.argv[sys.argv.index(nombre) + 1] if nombre in sys.argv else defecto


def clave_de(ruta):
    # La carpeta del proyecto en ~/.claude/projects: todo lo que no es alfanumerico ASCII pasa a "-".
    # Los worktrees de agentes y de integracion cuentan en su proyecto.
    plana = "".join(c if (c.isascii() and c.isalnum()) else "-" for c in ruta).lower()
    return re.sub("(--claude-worktrees-|-worktrees-).*$", "", plana)


def peso(modelo, u):
    for clave, entrada, salida in PESOS:
        if clave in modelo:
            leida = int(u.get("cache_read_input_tokens") or 0) * entrada * 0.1 / 1e6
            resto = (int(u.get("input_tokens") or 0) * entrada + int(u.get("output_tokens") or 0) * salida
                     + int(u.get("cache_creation_input_tokens") or 0) * entrada * 1.25) / 1e6
            return leida + resto, leida
    return 0.0, 0.0


def lunes(iso):
    d = datetime.fromisoformat(iso[:19] + "+00:00")
    return (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")


def nuevo():
    return {"sesiones": 0, "prompts": 0, "llamadas": 0, "peso": 0.0, "peso_sub": 0.0, "peso_relectura": 0.0,
            "despertares": 0, "vacios": 0, "agentes": 0, "semanas": {}}


def leer(ruta, desde_iso, p, es_sub, detalle):
    mensajes = {}
    vistos = set()
    try:
        f = open(ruta, "rb")
    except OSError:
        return False
    with f:
        for cruda in f:
            if b'"usage"' not in cruda:
                if not detalle or es_sub or b'"type":"user"' not in cruda or b'"tool_result"' in cruda:
                    continue
            try:
                r = json.loads(cruda)
            except Exception:
                continue
            t = r.get("timestamp")
            if not isinstance(t, str) or t < desde_iso:
                continue
            m = r.get("message")
            if not isinstance(m, dict):
                continue
            if r.get("type") == "assistant" and isinstance(m.get("usage"), dict):
                # un mismo mensaje sale en varias lineas (una por bloque): gana la ultima
                mensajes[m.get("id") or r.get("uuid")] = (str(m.get("model") or "?"), m["usage"], t)
                if not detalle:
                    continue
                for b in m.get("content") or []:
                    if not (isinstance(b, dict) and b.get("type") == "tool_use") or b.get("id") in vistos:
                        continue
                    vistos.add(b.get("id"))
                    e = b.get("input") if isinstance(b.get("input"), dict) else {}
                    if b.get("name") == "ScheduleWakeup" and not e.get("stop"):
                        p["despertares"] += 1
                        p["vacios"] += 1 if e.get("noop") is True else 0
                    elif b.get("name") in ("Agent", "Task"):
                        p["agentes"] += 1
            elif r.get("type") == "user" and detalle and not es_sub and not r.get("isMeta"):
                c = m.get("content")
                if isinstance(c, list):
                    c = next((b.get("text") or "" for b in c if isinstance(b, dict) and b.get("type") == "text"), "")
                if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                    p["prompts"] += 1
    for modelo, u, t in mensajes.values():
        w, leida = peso(modelo, u)
        p["llamadas"] += 1
        p["peso"] += w
        p["peso_relectura"] += leida
        if es_sub:
            p["peso_sub"] += w
        k = lunes(t)
        p["semanas"][k] = p["semanas"].get(k, 0.0) + w
    return bool(mensajes)


def repo_de(raiz):
    try:
        r = subprocess.run(["git", "-C", raiz, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=15)
    except Exception:
        return ""
    m = re.search("github[.]com[:/]+([^/]+)/([^/]+?)(?:[.]git)?/?$", r.stdout.strip())
    return m.group(1) + "/" + m.group(2) if m else ""


def issues_de(repo, cuenta):
    # La cuenta es la configurada o, si no, la duena del repositorio; el token solo viaja en el entorno de gh.
    env = dict(os.environ)
    via = "cuenta activa de gh"
    for usuario in (cuenta, repo.split("/")[0]):
        if not usuario:
            continue
        try:
            t = subprocess.run(["gh", "auth", "token", "--user", usuario], capture_output=True, text=True, timeout=20)
        except Exception as exc:
            return None, via, "gh no esta disponible: " + str(exc)[:80]
        if t.returncode == 0 and t.stdout.strip():
            env["GH_TOKEN"] = t.stdout.strip()
            via = "cuenta " + usuario
            break
    try:
        r = subprocess.run(["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "3000",
                            "--json", "number,state,stateReason,createdAt,closedAt"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=env)
    except Exception as exc:
        return None, via, str(exc)[:120]
    if r.returncode != 0:
        lineas = (r.stderr or "gh fallo").strip().splitlines()
        return None, via, (lineas[-1] if lineas else "gh fallo")[:160]
    try:
        return json.loads(r.stdout), via, ""
    except Exception:
        return None, via, "gh no devolvio JSON"


def main():
    cwd = arg("--cwd", os.getcwd())
    raiz = arg("--raiz", cwd)
    dias = int(arg("--dias", "30"))
    factura = float(arg("--factura", "238"))
    repo = arg("--repo") or repo_de(raiz)
    cuenta = arg("--cuenta")
    mia = clave_de(cwd)
    cache = os.path.join(tempfile.gettempdir(), "claude-consumo-avance-" + mia + ".json")
    # --previa: la ultima medicion guardada, tenga la edad que tenga, para pintar algo mientras se mide.
    previa = "--previa" in sys.argv
    if previa or "--forzar" not in sys.argv:
        try:
            if previa or time.time() - os.path.getmtime(cache) < CADUCA_S:
                previo = json.load(open(cache, encoding="utf-8"))
                if (previo.get("dias") == dias and previo.get("factura") == factura
                        and (previo.get("repo") or {}).get("nombre") == repo):
                    print(json.dumps(dict(previo, de_cache=True), ensure_ascii=False))
                    return
        except Exception:
            pass
    if previa:
        print("{}")
        return

    # La ventana empieza el lunes de la semana de hace --dias dias: semanas enteras, consumo e issues alineados.
    ahora = datetime.now(timezone.utc)
    corte = ahora - timedelta(days=dias)
    desde = (corte - timedelta(days=corte.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    desde_iso = desde.strftime(FORMATO)
    base = os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".claude", "projects")
    proyectos = {}
    for nombre in (os.listdir(base) if os.path.isdir(base) else []):
        carpeta = os.path.join(base, nombre)
        if not os.path.isdir(carpeta):
            continue
        clave = clave_de(nombre)
        p = proyectos.setdefault(clave, nuevo())
        detalle = clave == mia
        for ruta in glob.glob(os.path.join(carpeta, "*.jsonl")):
            if os.path.getmtime(ruta) >= desde.timestamp() and leer(ruta, desde_iso, p, False, detalle):
                p["sesiones"] += 1
        for ruta in glob.glob(os.path.join(carpeta, "*", "subagents", "*.jsonl")):
            if os.path.getmtime(ruta) >= desde.timestamp():
                leer(ruta, desde_iso, p, True, detalle)

    total = sum(p["peso"] for p in proyectos.values())
    yo = proyectos.get(mia) or nuevo()
    parte = yo["peso"] / total if total > 0 else 0.0
    proyecto = {
        "clave": mia, "sesiones": yo["sesiones"], "prompts": yo["prompts"], "llamadas": yo["llamadas"],
        "pct_del_total": round(100 * parte, 1), "usd_factura": round(parte * factura, 2),
        "pct_subagentes": round(100 * yo["peso_sub"] / yo["peso"], 1) if yo["peso"] > 0 else 0.0,
        "pct_relectura": round(100 * yo["peso_relectura"] / yo["peso"], 1) if yo["peso"] > 0 else 0.0,
        "despertares": yo["despertares"], "despertares_vacios": yo["vacios"], "agentes": yo["agentes"],
    }
    reparto = []
    if total > 0:
        for k, p in sorted(proyectos.items(), key=lambda kv: -kv[1]["peso"])[:5]:
            if p["peso"] > 0:
                reparto.append({"nombre": re.sub("^[a-z]--(code-)?", "", k) or k,
                                "pct": round(100 * p["peso"] / total, 1), "usd": round(p["peso"] / total * factura, 2)})

    info = {"nombre": repo, "via": "", "error": "", "abiertas": 0, "creadas": 0, "hechas": 0, "descartadas": 0,
            "usd_por_issue": None}
    issues = []
    if not repo:
        info["error"] = "este proyecto no tiene remoto de GitHub"
    else:
        lista, info["via"], info["error"] = issues_de(repo, cuenta)
        issues = lista or []

    semanas = []
    d = desde
    while d <= ahora:
        ini = d.strftime(FORMATO)
        fin = (d + timedelta(days=7)).strftime(FORMATO)
        cerradas = [i for i in issues if i.get("closedAt") and ini <= i["closedAt"] < fin]
        descartadas = sum(1 for i in cerradas if i.get("stateReason") == "NOT_PLANNED")
        w = yo["semanas"].get(d.strftime("%Y-%m-%d"), 0.0)
        semanas.append({
            "lunes": d.strftime("%Y-%m-%d"),
            "creadas": sum(1 for i in issues if ini <= (i.get("createdAt") or "") < fin),
            "hechas": len(cerradas) - descartadas,
            "descartadas": descartadas,
            "abiertas_fin": sum(1 for i in issues if (i.get("createdAt") or "") < fin)
            - sum(1 for i in issues if i.get("closedAt") and i["closedAt"] < fin),
            "usd_factura": round(w / total * factura, 2) if total > 0 else 0.0,
            "pct_del_proyecto": round(100 * w / yo["peso"], 1) if yo["peso"] > 0 else 0.0,
        })
        d += timedelta(days=7)
    info["abiertas"] = sum(1 for i in issues if i.get("state") == "OPEN")
    info["creadas"] = sum(s["creadas"] for s in semanas)
    info["hechas"] = sum(s["hechas"] for s in semanas)
    info["descartadas"] = sum(s["descartadas"] for s in semanas)
    if info["hechas"] > 0 and not info["error"]:
        info["usd_por_issue"] = round(proyecto["usd_factura"] / info["hechas"], 2)

    salida = {
        "ahora": ahora.timestamp(), "desde": desde.strftime("%Y-%m-%d"), "dias": dias, "factura": factura,
        "proyectos_con_actividad": sum(1 for p in proyectos.values() if p["peso"] > 0),
        "proyecto": proyecto, "repo": info, "semanas": semanas, "reparto": reparto, "de_cache": False,
    }
    cuerpo = json.dumps(salida, ensure_ascii=False)
    if not info["error"]:
        try:
            with open(cache, "w", encoding="utf-8") as f:
                f.write(cuerpo)
        except OSError:
            pass
    print(cuerpo)


main()
`

function miles(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

function corto(modelo: string): string {
  return modelo.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function hora(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const d = new Date(ms)
  const dos = (x: number) => String(x).padStart(2, '0')
  return `${dos(d.getHours())}:${dos(d.getMinutes())}`
}

function duracion(min: number | null | undefined): string {
  if (min === null || min === undefined || !isFinite(min)) return '—'
  const total = Math.max(0, Math.round(min))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`
}

function barra(fraccion: number | null, ancho: number): string {
  if (fraccion === null || !isFinite(fraccion)) return '░'.repeat(ancho)
  const f = Math.min(1, Math.max(0, fraccion))
  const llenos = Math.round(f * ancho)
  return '█'.repeat(llenos) + '░'.repeat(ancho - llenos)
}

function tono(fraccion: number | null): string {
  if (fraccion === null || !isFinite(fraccion)) return 'gray'
  if (fraccion < 0.6) return 'green'
  if (fraccion < 0.85) return 'yellow'
  return 'red'
}

function chispas(valores: number[]): string {
  const simbolos = '▁▂▃▄▅▆▇█'
  const max = Math.max(0, ...valores)
  if (max <= 0) return '▁'.repeat(valores.length)
  return valores.map(v => simbolos[Math.min(7, Math.round((v / max) * 7))]).join('')
}

function numero(x: unknown, porDefecto: number): number {
  return typeof x === 'number' && isFinite(x) ? x : porDefecto
}

function texto(x: unknown, porDefecto: string): string {
  return typeof x === 'string' && x.trim() ? x.trim() : porDefecto
}

function fechaCorta(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}` : '—'
}

async function pythonDe($: any, root: string): Promise<string> {
  const venv = root.replace(/[\\/]+$/, '') + '/.venv/Scripts/python.exe'
  return (await $.fs.exists(venv)) ? venv : 'python'
}

const barras = (ruta: string): string => ruta.replace(/\\/g, '/').replace(/\/+$/, '')
const primeraLinea = (t: string): string => (t.split(/\r?\n/).find(l => l.trim()) ?? '').trim().slice(0, 160)

async function correr($: any, argv: string[], cwd: string, timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: r.exitCode === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch (exc) {
    return { ok: false, stdout: '', stderr: String(exc) }
  }
}

// GitHub del producto sólo con el envoltorio del repositorio: su token y su identidad, comprobada por él.
function ghDelProyecto(raiz: string, ...orden: string[]): string[] {
  return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${raiz}/scripts/gh-vt.ps1`, ...orden]
}

async function leerEstado($: any, raiz: string): Promise<{ estado: Estado; texto: string }> {
  try {
    const leido = String(await $.fs.read(`${raiz}/.claude/orquestacion.json`))
    return { estado: JSON.parse(leido) as Estado, texto: leido }
  } catch {
    return { estado: {}, texto: '' }
  }
}

/** Las issues abiertas, de GitHub y no de un recuerdo. Si GitHub no responde, se dice y no se inventa nada. */
async function leerIssues($: any, raiz: string, repoGh: string): Promise<{ issues: Issue[] | null; github: string }> {
  if (!repoGh) return { issues: null, github: 'NO MEDIDO: el repositorio no tiene remoto de GitHub' }
  const base = ['issue', 'list', '--repo', repoGh, '--state', 'open', '--limit', '300', '--json']
  let conProyecto = true
  let r = await correr($, ghDelProyecto(raiz, ...base, 'number,title,labels,body,projectItems'), raiz, 60_000)
  if (!r.ok) {
    conProyecto = false
    r = await correr($, ghDelProyecto(raiz, ...base, 'number,title,labels,body'), raiz, 60_000)
  }
  if (!r.ok) return { issues: null, github: `NO MEDIDO: ${primeraLinea(r.stderr) || 'gh-vt.ps1 no respondió'}` }
  try {
    const filas = JSON.parse(r.stdout) as { number: number; title: string; labels?: { name: string }[]; body?: string; projectItems?: unknown[] }[]
    return {
      issues: filas.map(f => ({
        numero: f.number,
        titulo: f.title ?? '',
        etiquetas: (f.labels ?? []).map(l => l.name),
        cuerpo: f.body ?? '',
        enProyecto: conProyecto ? (f.projectItems ?? []).length > 0 : null,
        commits: [],
        medida: true,
      })),
      github: conProyecto ? 'ok' : 'ok, sin la pertenencia al proyecto (la credencial no la deja leer)',
    }
  } catch {
    return { issues: null, github: 'NO MEDIDO: la respuesta de gh no es JSON' }
  }
}

/** Qué commits de main nombran cada issue: un solo `git log --grep`, repartido por número. */
async function leerCommits($: any, raiz: string, numeros: number[]): Promise<Map<number, string[]>> {
  const mapa = new Map<number, string[]>(numeros.map(n => [n, []]))
  if (!numeros.length) return mapa
  const r = await correr($, ['git', '-C', raiz, 'log', 'main', '--oneline', '-E', `--grep=#(${numeros.join('|')})([^0-9]|$)`, '-n', '400'], raiz)
  for (const linea of r.stdout.split(/\r?\n/)) {
    for (const n of numeros) {
      if (new RegExp(`#${n}(?!\\d)`).test(linea)) mapa.get(n)!.push(linea.trim().slice(0, 120))
    }
  }
  return mapa
}

/** Actividad de cada externo, medida por su rama agente/número: lo último entre su commit y sus ficheros sin confirmar. */
async function leerActividad($: any, raiz: string, ahoraMs: number): Promise<Actividad> {
  const actividad: Actividad = {}
  for (const quien of EXTERNOS) {
    const suArbol = arbol(raiz, quien)
    const rama = (await correr($, ['git', '-C', suArbol, 'rev-parse', '--abbrev-ref', 'HEAD'], raiz, 15_000)).stdout.trim()
    const m = new RegExp(`^${quien}/(\\d+)`).exec(rama)
    if (!m) {
      actividad[quien] = null
      continue
    }
    let ultimo = Number((await correr($, ['git', '-C', suArbol, 'log', '-1', '--format=%ct'], raiz, 15_000)).stdout.trim()) * 1000 || 0
    const sucios = (await correr($, ['git', '-C', suArbol, 'status', '--porcelain'], raiz, 20_000)).stdout.split(/\r?\n/).filter(Boolean).slice(0, 20)
    for (const linea of sucios) {
      const nombre = linea.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop()!
      try {
        ultimo = Math.max(ultimo, (await $.fs.stat(`${suArbol}/${nombre}`)).mtimeMs)
      } catch {
        // Un fichero borrado no tiene hora: no cuenta.
      }
    }
    actividad[quien] = { rama, issue: Number(m[1]), hace_min: ultimo ? (ahoraMs - ultimo) / 60_000 : Number.POSITIVE_INFINITY }
  }
  return actividad
}

async function candadoDeSuite($: any, raiz: string): Promise<string> {
  try {
    if (!(await $.fs.exists(`${raiz}/.vt-suite.lock`))) return ''
    return primeraLinea(String(await $.fs.read(`${raiz}/.vt-suite.lock`)).replace(/\s+/g, ' ')) || 'tomado'
  } catch {
    return ''
  }
}

type Decision = { salida: Salida; github: string; orden: string; estado: Estado; raiz: string; repoGh: string }

/**
 * El control: mide, decide (router.ts) y escribe. Sólo actúa en un repositorio que tenga .claude/orquestacion.json.
 * `cambio` aplica una orden a mano (fuera, tomar) sobre lo leído antes de decidir; si devuelve texto, es un rechazo.
 */
async function controlar($: any, repoCfg: string, cambio?: (estado: Estado, issues: Issue[]) => string | null): Promise<Decision | { error: string } | null> {
  const raiz = barras(String(await $.session.root()))
  if (!(await $.fs.exists(`${raiz}/.claude/orquestacion.json`))) {
    await update($, control, c => ({ ...c, activo: false }))
    return null
  }
  const { estado: leido, texto: antes } = await leerEstado($, raiz)
  const repoGh = await repoDe($, repoCfg)
  const { issues: medidas, github } = await leerIssues($, raiz, repoGh)
  // Sin GitHub no se da nada por cerrado ni se inventan títulos: se enruta la cola escrita, marcada como no medida.
  const colaEscrita = leido.cola?.length ? leido.cola : [...COLA_INICIAL]
  const issues: Issue[] =
    medidas ??
    [...new Set([...colaEscrita, ...Object.keys(leido.asignaciones ?? {}).map(Number)])].map(numero => ({
      numero,
      titulo: leido.clasificacion?.find(f => f.numero === numero)?.titulo ?? '',
      etiquetas: [],
      cuerpo: '',
      enProyecto: null,
      commits: [],
      medida: false,
    }))
  const commits = await leerCommits($, raiz, issues.map(i => i.numero))
  for (const i of issues) i.commits = commits.get(i.numero) ?? []
  if (cambio) {
    const rechazo = cambio(leido, issues)
    if (rechazo) return { error: rechazo }
  }
  const ahoraMs = await $.clock.now()
  const salida = enrutar({
    raiz,
    issues,
    estado: leido,
    actividad: await leerActividad($, raiz, ahoraMs),
    ahora: new Date(ahoraMs).toISOString(),
    abiertas: medidas ? new Set(medidas.map(i => i.numero)) : null,
  })
  const estado = conDecision(leido, salida, github, medidas ? medidas.length : null, leido.router?.pendientes ?? [])
  const despues = `${JSON.stringify(estado, null, 2)}\n`
  // Sólo se escribe si la decisión cambió: el fichero está versionado y un árbol sucio no se despliega.
  if (despues !== antes) await $.fs.write(`${raiz}/.claude/orquestacion.json`, despues)
  const nuevo: Control = { cuando: ahoraMs, activo: true, github, candado: await candadoDeSuite($, raiz), frases: frases(salida, orden(estado)), resto: resto(salida), avisos: salida.avisos, orden: orden(estado).texto }
  await update($, control, () => nuevo)
  return { salida, github, orden: nuevo.orden, estado, raiz, repoGh }
}

function asignacionAMano(i: Issue, estado: Estado, quien: Trabajador, raiz: string, ahora: string, motivo: string): Asignacion {
  const d = estado.declarado?.[String(i.numero)]
  const { puntos } = pesar(i, d)
  const t = tabla(puntos)
  return {
    trabajador: quien,
    clase: clasificar(i, d),
    puntos,
    peso: t.peso,
    esfuerzo: t.esfuerzo,
    estado: 'vigente',
    desde: ahora,
    motivo,
    ...(quien === 'claude' ? {} : { arbol: arbol(raiz, quien), rama: `${quien}/${i.numero}` }),
  }
}

/** «/consumo agentes | fuera <agy|codex> <motivo> | tomar <número> <agy|codex|claude>»: ejecuta el control y responde en frases. */
async function ordenDeControl($: any, repoCfg: string, argumentos: string): Promise<string> {
  const [verbo = '', a = '', ...mas] = argumentos.split(/\s+/)
  const raiz = barras(String(await $.session.root()))
  const ahora = new Date(await $.clock.now()).toISOString()
  let linea = ''
  let nota: { numero: number; texto: string } | null = null
  let cambio: ((estado: Estado, issues: Issue[]) => string | null) | undefined

  if (verbo.toLowerCase() === 'fuera') {
    const quien = a.toLowerCase() as Trabajador
    const motivo = mas.join(' ').trim()
    if (!EXTERNOS.includes(quien) || !motivo) return 'Uso: «/consumo fuera <agy|codex> <motivo>». El motivo es obligatorio: queda visible.'
    cambio = estado => {
      estado.fuera = { ...(estado.fuera ?? {}), [quien]: `${motivo} (desde el ${ahora.slice(0, 10)})` }
      linea = `${quien} queda fuera: ${motivo}.`
      return null
    }
  } else if (verbo.toLowerCase() === 'tomar') {
    const numero = Number(a.replace('#', ''))
    const quien = (mas[0] ?? '').toLowerCase() as Trabajador
    if (!Number.isInteger(numero) || numero <= 0 || !TRABAJADORES.includes(quien)) return 'Uso: «/consumo tomar <número> <agy|codex|claude>».'
    cambio = (estado, issues) => {
      const i = issues.find(x => x.numero === numero)
      if (!i) return `La #${numero} no está abierta ni en la cola: no se asigna.`
      const d = estado.declarado?.[String(numero)]
      const clase = clasificar(i, d)
      if (clase === 'Decisión') return `La #${numero} es una Decisión: espera al dueño y no se asigna a nadie.`
      if (clase === 'Épica') return `La #${numero} es una épica: no lleva trabajador.`
      const motivoFuera = estado.fuera?.[quien]
      if (motivoFuera) return `${quien} está fuera (${motivoFuera}): no recibe la #${numero}.`
      if (quien !== 'claude' && (d?.solo_sesion || pesar(i, d).criterios.produccion)) return `La #${numero} toca producción o está reservada a esta sesión: no se delega a ${quien}.`
      const otra = Object.entries(estado.asignaciones ?? {}).find(([n, x]) => Number(n) !== numero && (x.trabajador === quien || x.contra === quien))
      if (otra) return `${quien} ya tiene la #${otra[0]}. Un trabajador, una issue: libérala antes.`
      const antes = estado.asignaciones?.[String(numero)]?.trabajador
      const nueva = asignacionAMano(i, estado, quien, raiz, ahora, `reasignada a mano${antes ? ` desde ${antes}` : ''}`)
      estado.asignaciones = { ...(estado.asignaciones ?? {}), [String(numero)]: nueva }
      estado.reasignado = { ...(estado.reasignado ?? {}), [String(numero)]: `${quien} (a mano, ${ahora.slice(0, 10)})` }
      linea = `La #${numero} pasa a ${quien}.`
      nota = { numero, texto: `Control: la #${numero} pasa a ${quien}${antes ? ` (antes, ${antes})` : ''}; peso ${nueva.peso}, esfuerzo ${nueva.esfuerzo}. Reasignada a mano el ${ahora.slice(0, 10)}.` }
      return null
    }
  }

  const r = await controlar($, repoCfg, cambio)
  if (!r) return 'Este repositorio no tiene .claude/orquestacion.json: el control no decide aquí.'
  if ('error' in r) return r.error

  const anotado: string[] = []
  const pendiente = nota as { numero: number; texto: string } | null
  if (pendiente) {
    // Una línea en la issue, no un informe. Si GitHub no la acepta, queda pendiente y a la vista.
    const c = await correr($, ghDelProyecto(r.raiz, 'issue', 'comment', String(pendiente.numero), '--repo', r.repoGh, '--body', pendiente.texto), r.raiz, 45_000)
    if (c.ok) anotado.push(`Anotado en la #${pendiente.numero}.`)
    else {
      anotado.push(`No se pudo anotar en la #${pendiente.numero} (${primeraLinea(c.stderr) || 'gh-vt.ps1 falló'}): queda pendiente en .claude/orquestacion.json.`)
      const conPendiente = { ...r.estado, router: { ...r.estado.router!, pendientes: [...(r.estado.router?.pendientes ?? []), `#${pendiente.numero}: ${pendiente.texto}`] } }
      await $.fs.write(`${r.raiz}/.claude/orquestacion.json`, `${JSON.stringify(conPendiente, null, 2)}\n`)
    }
  }
  return [linea, ...frases(r.salida, orden(r.estado)), ...resto(r.salida), ...r.salida.avisos, ...anotado, r.github === 'ok' ? '' : `GitHub: ${r.github}.`].filter(Boolean).join('\n')
}

async function refrescar($: any): Promise<void> {
  const ahora = await $.clock.now()
  let error = ''
  try {
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const root = await $.session.root()
    const py = await pythonDe($, root)
    const r = await $.process.run([py, '-I', '-', '--sesion', id, '--cwd', cwd], {
      stdin: RESUMIDOR,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      timeoutMs: 60_000,
    })
    if (r.exitCode === 0 && r.stdout.trim()) {
      const datos = JSON.parse(r.stdout) as Resumen
      await update($, resumen, () => datos)
    } else {
      error = (r.stderr || 'el resumidor no devolvió nada').trim().split('\n').slice(-1)[0].slice(0, 160)
    }
  } catch (exc) {
    error = String(exc).slice(0, 160)
  }
  const s: Sesion = { usdMotor: null, contextoPct: null, contextoTokens: null, ventana: null, inicio: null, actualizado: ahora, error }
  try {
    const u = await $.session.usage()
    s.usdMotor = u.cost?.usd ?? null
    s.contextoPct = u.context.percent ?? null
    s.contextoTokens = u.context.tokens ?? null
    s.ventana = u.context.window ?? null
    s.inicio = u.startedAt ?? null
  } catch (exc) {
    s.error = s.error || String(exc).slice(0, 160)
  }
  await update($, sesion, () => s)
}

// El repositorio es el configurado o, si no hay, el remoto `origin` del proyecto: así el mismo mod sirve
// en cualquier repositorio sin tocar su configuración.
let repoDetectado: string | null = null

async function repoDe($: any, configurado: string): Promise<string> {
  if (configurado) return configurado
  if (repoDetectado !== null) return repoDetectado
  try {
    const root = await $.session.root()
    const r = await $.process.run(['git', '-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 })
    const m = r.stdout.trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    repoDetectado = m ? `${m[1]}/${m[2]}` : ''
  } catch {
    repoDetectado = ''
  }
  return repoDetectado
}

async function consultarGitHub($: any, repoCfg: string, cuentaCfg: string): Promise<void> {
  const ahora = await $.clock.now()
  const repo = await repoDe($, repoCfg)
  if (!repo) {
    await update($, github, g => ({ ...g, repo: '', cuando: ahora, error: 'este proyecto no tiene remoto de GitHub' }))
    return
  }
  // La cuenta es la configurada o, si no hay, la dueña del repositorio; nunca cambia la cuenta activa de gh.
  const cuenta = cuentaCfg || repo.split('/')[0]
  const env: Record<string, string> = {}
  try {
    const t = await $.process.run(['gh', 'auth', 'token', '--user', cuenta], { timeoutMs: 20_000 })
    if (t.exitCode === 0 && t.stdout.trim()) env.GH_TOKEN = t.stdout.trim()
  } catch {
    // sin token explícito: gh usa su cuenta activa
  }
  try {
    const [i, p] = await Promise.all([
      $.process.run(['gh', 'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(TOPE_GITHUB), '--json', 'number,title,labels,updatedAt'], { env, timeoutMs: 45_000 }),
      $.process.run(['gh', 'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(TOPE_GITHUB), '--json', 'number,title,isDraft,updatedAt'], { env, timeoutMs: 45_000 }),
    ])
    if (i.exitCode !== 0 || p.exitCode !== 0) {
      const motivo = (i.stderr || p.stderr).trim().split('\n').slice(-1)[0] ?? 'gh falló'
      await update($, github, g => ({ ...g, repo, cuando: ahora, error: motivo.slice(0, 160) }))
      return
    }
    const issues = (JSON.parse(i.stdout) as any[]).map(x => ({
      number: Number(x.number),
      title: String(x.title ?? ''),
      labels: Array.isArray(x.labels) ? x.labels.map((l: any) => String(l.name ?? l)) : [],
      updatedAt: String(x.updatedAt ?? ''),
    }))
    const prs = (JSON.parse(p.stdout) as any[]).map(x => ({
      number: Number(x.number),
      title: String(x.title ?? ''),
      isDraft: Boolean(x.isDraft),
      updatedAt: String(x.updatedAt ?? ''),
    }))
    await update($, github, () => ({ repo, cuando: ahora, issues, prs, error: '' }))
  } catch (exc) {
    await update($, github, g => ({ ...g, repo, cuando: ahora, error: String(exc).slice(0, 160) }))
  }
}

function aAvance(d: any, estado: string, cuando: number | null, factura: number): Avance {
  return {
    estado,
    cuando,
    error: '',
    desde: String(d.desde ?? ''),
    factura: Number(d.factura ?? factura),
    proyecto: d.proyecto ?? null,
    repo: d.repo ?? null,
    semanas: Array.isArray(d.semanas) ? d.semanas : [],
    reparto: Array.isArray(d.reparto) ? d.reparto : [],
  }
}

async function argvAvance($: any, repoCfg: string, cuentaCfg: string, factura: number): Promise<string[]> {
  const cwd = await $.session.cwd()
  const root = await $.session.root()
  const py = await pythonDe($, root)
  const argv = [py, '-I', '-', '--cwd', cwd, '--raiz', root, '--factura', String(factura)]
  if (repoCfg) argv.push('--repo', repoCfg)
  if (cuentaCfg) argv.push('--cuenta', cuentaCfg)
  return argv
}

// Al abrir la sesión se pinta la última medición guardada, con su hora, mientras corre la nueva: medir
// tarda medio minuto y un tablero vacío durante ese rato no dice nada.
async function avancePrevio($: any, repoCfg: string, cuentaCfg: string, factura: number): Promise<void> {
  try {
    if ((await read($, avance)).proyecto) return
    const argv = await argvAvance($, repoCfg, cuentaCfg, factura)
    const r = await $.process.run([...argv, '--previa'], { stdin: AVANCE_PY, timeoutMs: 30_000 })
    if (r.exitCode !== 0 || !r.stdout.trim()) return
    const d = JSON.parse(r.stdout)
    if (!d.proyecto) return
    const cuando = typeof d.ahora === 'number' ? d.ahora * 1000 : null
    await update($, avance, a => (a.proyecto ? a : aAvance(d, a.estado, cuando, factura)))
  } catch {
    // sin medición previa: se espera a la nueva
  }
}

async function medirAvance($: any, repoCfg: string, cuentaCfg: string, factura: number, forzar: boolean): Promise<Avance> {
  const ahora = await $.clock.now()
  await update($, avance, a => ({ ...a, estado: 'midiendo' }))
  let error = ''
  try {
    const argv = await argvAvance($, repoCfg, cuentaCfg, factura)
    if (forzar) argv.push('--forzar')
    const r = await $.process.run(argv, { stdin: AVANCE_PY, timeoutMs: 300_000 })
    if (r.exitCode === 0 && r.stdout.trim()) {
      const medido = aAvance(JSON.parse(r.stdout), 'lista', ahora, factura)
      await update($, avance, () => medido)
      return medido
    }
    error = (r.stderr || 'la medición no devolvió nada').trim().split('\n').slice(-1)[0].slice(0, 160)
  } catch (exc) {
    error = String(exc).slice(0, 160)
  }
  // Si falla se conserva la última medición buena, con el error a la vista.
  await update($, avance, a => ({ ...a, estado: 'error', cuando: ahora, error }))
  return await read($, avance)
}

// Cuándo se vaciaría el tablero al ritmo medido: cierres menos altas por semana, sobre las últimas cuatro
// semanas completas (la última fila es la semana en curso y no cuenta). Es una extrapolación, no un compromiso.
function proyeccion(a: Avance): string {
  if (!a.repo || a.repo.error || a.semanas.length < 3) return ''
  const completas = a.semanas.slice(0, -1).slice(-4)
  const n = completas.length
  const cierres = completas.reduce((s, x) => s + x.hechas + x.descartadas, 0) / n
  const altas = completas.reduce((s, x) => s + x.creadas, 0) / n
  const ritmo = `${cierres.toFixed(1)} cierres y ${altas.toFixed(1)} altas por semana (${n} semanas)`
  if (a.repo.abiertas === 0) return 'Proyección: no quedan issues abiertas'
  const sinAltas = cierres > 0 ? ` · sin altas nuevas, ≈ ${Math.ceil(a.repo.abiertas / cierres)} semanas` : ''
  if (cierres <= altas) return `Proyección: a ${ritmo} el tablero no se vacía, crece${sinAltas}`
  const semanas = Math.ceil(a.repo.abiertas / (cierres - altas))
  const base = Date.parse((a.semanas[a.semanas.length - 1]?.lunes ?? '') + 'T00:00:00Z')
  const fin = new Date(base + semanas * 7 * 86400000).toISOString().slice(0, 10)
  return `Proyección: a ${ritmo}, las ${a.repo.abiertas} abiertas se cierran en ≈ ${semanas} semanas (hacia el ${fechaCorta(fin)})${sinAltas}`
}

function lineaAvance(a: Avance): string {
  if (a.estado === 'error' || !a.proyecto) return `avance: ${a.error || 'sin medición'}`
  const repo =
    a.repo && !a.repo.error
      ? `${a.repo.nombre}: ${a.repo.hechas} issues cerradas, ${a.repo.creadas} creadas y ${a.repo.abiertas} abiertas desde el ${fechaCorta(a.desde)}`
      : `GitHub: ${a.repo ? a.repo.error : 'sin repositorio'}`
  const porIssue = a.repo && a.repo.usd_por_issue !== null ? ` · ≈ ${a.repo.usd_por_issue.toFixed(2)} USD por issue cerrada` : ''
  return `avance ${repo} · este proyecto ≈ ${a.proyecto.usd_factura.toFixed(0)} USD de la factura de ${a.factura} (${a.proyecto.pct_del_total} %)${porIssue}${proyeccion(a) ? ' · ' + proyeccion(a).toLowerCase() : ''}`
}

function porcentaje(texto: string): number | null {
  const total = texto.match(/^TOTAL\s.*?(\d+)%/m)
  if (total) return Number(total[1])
  const solo = texto.trim().match(/^(\d+)$/)
  return solo ? Number(solo[1]) : null
}

async function medirCobertura($: any, correrPruebas: boolean): Promise<Cobertura> {
  const root = await $.session.root()
  const py = await pythonDe($, root)
  const ahora = await $.clock.now()
  try {
    // Sólo se mide donde hay pytest: en un repositorio sin él, lanzar la suite no mediría nada.
    const base = root.replace(/[\\/]+$/, '')
    let conPytest = false
    for (const marca of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
      if (await $.fs.exists(`${base}/${marca}`)) conPytest = true
    }
    if (!conPytest) {
      return { total: null, estado: 'no-aplica', cuando: ahora, nota: 'este repositorio no usa pytest; aquí la cobertura no se mide' }
    }
    if (correrPruebas) {
      await update($, cobertura, c => ({ ...c, estado: 'corriendo', nota: 'pytest --cov en marcha (unos 5 min)' }))
      const r = await $.process.run([py, '-m', 'pytest', '--cov', '--cov-report=term', '-q', '-p', 'no:cacheprovider'], {
        cwd: root,
        timeoutMs: 600_000,
      })
      const total = porcentaje(r.stdout)
      const ultima = r.stdout.trim().split('\n').slice(-1)[0] ?? ''
      return { total, estado: total === null ? 'error' : 'lista', cuando: ahora, nota: ultima.slice(0, 120) }
    }
    const r = await $.process.run([py, '-m', 'coverage', 'report', '--format=total'], { cwd: root, timeoutMs: 60_000 })
    const total = porcentaje(r.stdout)
    if (total === null) {
      const motivo = (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''
      return { total: null, estado: 'sin-dato', cuando: ahora, nota: motivo.slice(0, 120) }
    }
    return { total, estado: 'lista', cuando: ahora, nota: 'de .coverage, sin correr las pruebas' }
  } catch (exc) {
    return { total: null, estado: 'error', cuando: ahora, nota: String(exc).slice(0, 120) }
  }
}

async function actualizarCobertura($: any, correrPruebas: boolean): Promise<Cobertura> {
  const c = await medirCobertura($, correrPruebas)
  await update($, cobertura, () => c)
  return c
}

function lineaResumen(r: Resumen | null, s: Sesion): string {
  if (!r) return 'consumo: sin datos todavía' + (s.error ? ` (${s.error})` : '')
  const t = r.total
  const motor = s.usdMotor === null ? '' : ` · motor ${s.usdMotor.toFixed(2)} USD`
  return `consumo: ${t.llamadas} llamadas · salida ${miles(t.output_tokens)} · caché leída ${miles(t.cache_read_input_tokens)} · estimado ${t.usd.toFixed(2)} USD${motor} · ritmo ${r.ritmo.usd_por_hora.toFixed(1)} USD/h`
}

export const register: Register = (on, options) => {
  const presupuesto = numero(options.presupuestoUsd, 200)
  const factura = numero(options.facturaMensualUsd, 238)
  // Vacíos por defecto: el repositorio sale del remoto `origin` y la cuenta es la dueña del repositorio.
  const repo = texto(options.repo, '')
  const cuenta = texto(options.cuentaGitHub, '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'consumo',
      description:
        'Mide, gestiona y controla: «/consumo» pinta el panel, «/consumo avance» mide el avance real, «/consumo agentes» ejecuta el control y dice quién tiene cada issue y qué hará el próximo despertar, «/consumo fuera <agy|codex> <motivo>» saca a un trabajador y mueve su issue, «/consumo tomar <número> <agy|codex|claude>» reasigna a mano, «/consumo github» relee issues y PR, «/consumo cobertura» corre pytest con cobertura.',
    })
    // Controla antes de pintar: si no hay asignación vigente, asigna la primera de la cola que no espere al dueño.
    await controlar($, repo).catch(() => null)
    void $.ui.open({ id: PANE, title: 'Consumo' })
    void refrescar($)
    void actualizarCobertura($, false)
    void consultarGitHub($, repo, cuenta)
    void avancePrevio($, repo, cuenta, factura).then(() => medirAvance($, repo, cuenta, factura, false))
    // La transcripción aparece con el primer mensaje: se relee pronto en vez de esperar tres minutos.
    $.clock.after(45_000, () => {
      void refrescar($)
    })
    $.clock.every(180_000, () => {
      void refrescar($)
    })
    $.clock.every(1_800_000, () => {
      void medirAvance($, repo, cuenta, factura, false)
    })
    $.clock.every(600_000, () => {
      void consultarGitHub($, repo, cuenta)
    })
    return next(e)
  })

  // Cada despertar del bucle vuelve a decidir, y al modelo le llega SÓLO la orden: la issue, el siguiente paso
  // sin hacer, el criterio y los archivos; o parar. El prompt del bucle no entra: releerlo entero en cada
  // despertar era pagar dos veces. Cuando el bucle se reprograma con esta misma orden, el siguiente despertar
  // la vuelve a armar desde el fichero, así que un paso marcado hecho cambia la orden sin que nadie la reescriba.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'scheduled-trigger') return next(e)
    const r = await controlar($, repo)
    if (!r || 'error' in r) return next(e)
    return next({ ...e, text: r.orden })
    // Si el control falla, entra el prompt original: un despertar nunca se pierde por él.
  }).catch(($, e, next) => next(e))

  // La misma orden, en pocas líneas y con alcance de sesión: es donde la lee quien empieza a trabajar.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const c = await read($, control)
    if (!c.activo || !c.orden) return r
    return { ...r, sections: [...r.sections, { id: 'consumo:control', text: `Control de consumo (.claude/orquestacion.json).\n${c.orden}`, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) void refrescar($)
    return r
  })

  on('command.run', { command: 'consumo' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    await $.ui.open({ id: PANE, title: 'Consumo' })
    if (args.startsWith('cobertura')) {
      const c = await actualizarCobertura($, true)
      return { text: c.total === null ? `cobertura: ${c.estado} (${c.nota})` : `cobertura: ${c.total} % (${c.nota})` }
    }
    if (args.startsWith('avance')) {
      return { text: lineaAvance(await medirAvance($, repo, cuenta, factura, true)) }
    }
    if (args.startsWith('agentes') || args.startsWith('fuera') || args.startsWith('tomar')) {
      return { text: await ordenDeControl($, repo, e.args.trim()) }
    }
    if (args.startsWith('github')) {
      await consultarGitHub($, repo, cuenta)
      const g = await read($, github)
      return { text: g.error ? `github: ${g.error}` : `github ${g.repo}: ${cuantos(g.issues.length)} issues y ${cuantos(g.prs.length)} PR abiertos` }
    }
    await refrescar($)
    return { text: lineaResumen(await read($, resumen), await read($, sesion)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, resumen)
    const s = await read($, sesion)
    const c = await read($, cobertura)
    const g = await read($, github)
    const av = await read($, avance)
    const ctl = await read($, control)
    const conIssues = av.repo !== null && !av.repo.error
    const semanaActual = av.semanas[av.semanas.length - 1] ?? null
    const recienAbierta = !r || r.sin_transcripcion === true || r.total.llamadas === 0
    const conCobertura = c.estado !== 'no-aplica'
    const ancho = Math.max(44, e.props.bodyColumns ?? 70)
    const anchoBarra = Math.min(24, Math.max(10, ancho - 50))

    const gastado = s.usdMotor ?? (r ? r.total.usd : null)
    const fPresupuesto = gastado === null || presupuesto <= 0 ? null : gastado / presupuesto
    const fContexto = s.contextoPct === null ? null : s.contextoPct / 100
    const ritmoHora = r ? r.ritmo.usd_por_hora : 0
    const autonomiaMin = gastado === null || ritmoHora <= 0 ? null : ((presupuesto - gastado) / ritmoHora) * 60
    const minutosSesion = s.inicio === null ? null : (Date.now() - s.inicio) / 60_000
    const d = r ? r.despertador : null

    // El panel se lee en tres preguntas, en este orden. Cada cifra sale una vez y ninguna frase se corta.
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="wrap">
            1 · ¿Cuánto queda de presupuesto y de contexto? · sesión de {duracion(minutosSesion)} · {hora(s.actualizado)}
          </Text>
          <Text wrap="wrap">
            {`Presupuesto ${presupuesto} USD`.padEnd(22)}
            <Text color={tono(fPresupuesto)}>{barra(fPresupuesto, anchoBarra)}</Text>{' '}
            {gastado === null || fPresupuesto === null ? 'sin gasto medido todavía' : `quedan ${Math.max(0, presupuesto - gastado).toFixed(2)} USD (gastado el ${Math.round(fPresupuesto * 100)} %)`}
          </Text>
          <Text wrap="wrap">
            {'Tanque de contexto '.padEnd(22)}
            <Text color={tono(fContexto)}>{barra(fContexto, anchoBarra)}</Text>{' '}
            {s.contextoPct === null ? 'se mide con la primera respuesta' : `queda libre el ${Math.max(0, 100 - s.contextoPct)} %`}
            {s.contextoTokens === null ? '' : ` · ocupados ${miles(s.contextoTokens)}${s.ventana ? ' de ' + miles(s.ventana) : ''}`}
          </Text>
          <Text wrap="wrap">
            {'Ritmo (última hora) '.padEnd(22)}
            <Text color="cyan">{r ? chispas(r.ritmo.cubos_usd) : '▁'.repeat(12)}</Text>{' '}
            {recienAbierta || !r ? 'sin respuestas todavía' : `${ritmoHora.toFixed(1)} USD/h`}
          </Text>
          <Text wrap="wrap">
            {'Autonomía '.padEnd(22)}
            {recienAbierta
              ? 'sesión recién abierta: aún sin gasto'
              : autonomiaMin === null
                ? ritmoHora <= 0
                  ? 'en reposo: sin gasto en los últimos 30 min'
                  : '—'
                : `${duracion(autonomiaMin)} hasta el presupuesto, al ritmo actual`}
          </Text>
          {s.error ? <Text color="red" wrap="wrap">{s.error}</Text> : null}
        </Box>

        <Box flexDirection="column">
          <Text bold wrap="wrap">
            2 · ¿Esta semana se cierra trabajo o sólo se gasta? · Avance real · {av.repo && av.repo.nombre ? av.repo.nombre : repo || g.repo || 'repositorio por detectar'}
            {av.desde ? ` · desde el ${fechaCorta(av.desde)}` : ''}
            {av.cuando === null ? '' : ` · medido ${hora(av.cuando)}`}
            {av.estado === 'midiendo' ? (av.cuando === null ? ' · midiendo…' : ' · midiendo de nuevo…') : av.cuando === null ? ' · sin medir' : ''}
          </Text>
          {av.error ? <Text color="red" wrap="wrap">{av.error}</Text> : null}
          {av.repo && av.repo.error ? <Text color="red" wrap="wrap">GitHub: {av.repo.error}</Text> : null}
          {conIssues && semanaActual ? (
            semanaActual.hechas > 0 ? (
              <Text color="green" wrap="wrap">
                Se cierra trabajo. Esta semana: {semanaActual.hechas} issues cerradas con ≈ {semanaActual.usd_factura.toFixed(0)} USD de consumo ({semanaActual.creadas} creadas)
              </Text>
            ) : semanaActual.usd_factura >= 1 ? (
              <Text color="red" wrap="wrap">
                Sólo se gasta. Esta semana: ≈ {semanaActual.usd_factura.toFixed(0)} USD de consumo y ninguna issue cerrada ({semanaActual.creadas} creadas)
              </Text>
            ) : (
              <Text dimColor wrap="wrap">Esta semana todavía no tiene consumo ni cierres que contar</Text>
            )
          ) : null}
          {av.repo && conIssues ? (
            <Text wrap="wrap">
              Issues: {av.repo.hechas} cerradas · {av.repo.descartadas} descartadas · {av.repo.creadas} creadas · {av.repo.abiertas} abiertas hoy
            </Text>
          ) : null}
          {av.repo && conIssues && proyeccion(av) ? <Text wrap="wrap">{proyeccion(av)}</Text> : null}
          {av.proyecto ? (
            <Text wrap="wrap">
              Factura de {av.factura} USD: este proyecto ≈ {av.proyecto.usd_factura.toFixed(0)} USD ({av.proyecto.pct_del_total} %)
              {av.repo && av.repo.usd_por_issue !== null ? ` · ≈ ${av.repo.usd_por_issue.toFixed(2)} USD por issue cerrada` : ''}
            </Text>
          ) : (
            <Text dimColor wrap="wrap">
              {av.estado === 'midiendo'
                ? 'midiendo: lee las transcripciones de esta máquina y las issues del repositorio (medio minuto)'
                : 'sin medición todavía: «/consumo avance» la corre (tarda medio minuto)'}
            </Text>
          )}
          {av.semanas.slice(0, -1).map(sem => (
            <Text wrap="wrap">
              {fechaCorta(sem.lunes)}{' '}
              <Text color={!conIssues ? 'gray' : sem.hechas === 0 && sem.usd_factura >= 1 ? 'red' : 'green'}>{String(sem.hechas).padStart(3)} cerradas</Text> ·{' '}
              {String(sem.creadas).padStart(3)} creadas · {String(sem.abiertas_fin).padStart(3)} abiertas · {barra(sem.pct_del_proyecto / 100, 8)}{' '}
              {sem.usd_factura.toFixed(0).padStart(3)} USD
            </Text>
          ))}
          {av.proyecto ? (
            <Text wrap="wrap">
              Iteración: {av.proyecto.despertares} despertares del bucle, {av.proyecto.despertares_vacios} sin cambios · {av.proyecto.agentes} subagentes (
              {av.proyecto.pct_subagentes} % del consumo) · releer contexto {av.proyecto.pct_relectura} %
            </Text>
          ) : null}
          {av.reparto.length > 0 ? (
            <Text dimColor wrap="wrap">
              Reparto de la factura: {av.reparto.map(p => `${p.nombre} ${p.pct} %`).join(' · ')}
            </Text>
          ) : null}
          {g.error ? <Text color="red" wrap="wrap">GitHub: {g.error}</Text> : null}
          <Text wrap="wrap">
            Pendiente en GitHub · {hora(g.cuando)} · PR abiertos {cuantos(g.prs.length)} ({g.prs.filter(p => p.isDraft).length} en borrador)
            {g.cuando === null ? ' · leyendo…' : g.prs.length ? ': ' + g.prs.slice(0, VISIBLES_GITHUB).map(p => `#${p.number}${p.isDraft ? ' (borrador)' : ''} ${p.title}`).join(' · ') : ''}
            {conIssues ? '' : ` · issues abiertas ${cuantos(g.issues.length)}`}
          </Text>
          {conCobertura ? (
            <Text wrap="wrap">
              Cobertura de pruebas del repositorio: {c.total === null ? `sin dato (${c.estado})` : `${c.total} %`} · medida {hora(c.cuando)} · {c.nota}
            </Text>
          ) : null}
        </Box>

        <Box flexDirection="column">
          <Text bold wrap="wrap">
            3 · ¿Quién tiene cada issue y qué va a hacer el próximo despertar?{ctl.cuando === null ? '' : ` · decidido ${hora(ctl.cuando)}`}
          </Text>
          {!ctl.activo ? (
            <Text dimColor wrap="wrap">
              {ctl.cuando === null && ctl.frases.length === 0
                ? 'El control todavía no decidió, o este repositorio no tiene .claude/orquestacion.json: «/consumo agentes» lo ejecuta'
                : 'Este repositorio no tiene .claude/orquestacion.json: el control no decide aquí'}
            </Text>
          ) : null}
          {ctl.frases.map(f => (
            <Text wrap="wrap">{f}</Text>
          ))}
          {ctl.orden ? (
            <Text bold wrap="wrap">
              {ctl.orden}
            </Text>
          ) : null}
          {ctl.resto.map(f => (
            <Text dimColor wrap="wrap">
              {f}
            </Text>
          ))}
          {ctl.avisos.map(f => (
            <Text color="yellow" wrap="wrap">
              {f}
            </Text>
          ))}
          {ctl.activo && ctl.github && ctl.github !== 'ok' ? (
            <Text color="red" wrap="wrap">
              GitHub: {ctl.github}. La decisión sale de la cola escrita y de git.
            </Text>
          ) : null}
          {ctl.candado ? (
            <Text color="red" wrap="wrap">
              Candado de suites tomado ({ctl.candado}): el control no lanza verify, gate ni e2e.
            </Text>
          ) : null}
          {d ? (
            <Text wrap="wrap">
              Bucle: {d.parar ? 'detenido' : `próximo despertar ${hora(d.proximo ? d.proximo * 1000 : null)}${d.faltan_min !== undefined ? ` (en ${duracion(d.faltan_min)})` : ''}`} · {d.razon}
            </Text>
          ) : (
            <Text dimColor>Bucle: ninguno programado</Text>
          )}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" gap={2}>
          <Button hotkey="a" onPress={() => void refrescar($)}>
            Actualizar
          </Button>
          <Button hotkey="g" onPress={() => void consultarGitHub($, repo, cuenta)}>
            GitHub
          </Button>
          <Button hotkey="p" onPress={() => void medirAvance($, repo, cuenta, factura, true)}>
            Avance
          </Button>
          <Button hotkey="o" onPress={() => void controlar($, repo)}>
            Control
          </Button>
          {conCobertura ? (
            <Button hotkey="c" onPress={() => void actualizarCobertura($, true)}>
              pytest
            </Button>
          ) : null}
        </Box>
        {r ? <Text dimColor wrap="wrap">{r.nota_precios}</Text> : null}
      </Box>
    )
  })
}
