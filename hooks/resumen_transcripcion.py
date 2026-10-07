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
