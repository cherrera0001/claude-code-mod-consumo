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
# Version de la forma de la salida: una cache escrita por otra version no se reutiliza.
VERSION = 2
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
            "despertares": 0, "vacios": 0, "agentes": 0, "semanas": {}, "raices": set()}


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
                # la carpeta en que corria la sesion: de ahi sale la raiz del proyecto para el index
                if not es_sub and isinstance(r.get("cwd"), str) and r.get("cwd"):
                    p["raices"].add(r["cwd"])
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


def raiz_de(clave, p):
    # La raiz del proyecto: la carpeta mas corta, de las que sus sesiones usaron, cuya clave es la del proyecto
    # (un worktree comparte la clave y es mas largo). Con barras normales; vacia si ninguna coincide.
    propias = sorted((c for c in p["raices"] if clave_de(c) == clave), key=lambda c: (len(c), c))
    return propias[0].replace(os.sep, "/").rstrip("/") if propias else ""


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
                if (previo.get("version") == VERSION and previo.get("dias") == dias and previo.get("factura") == factura
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
                reparto.append({"nombre": re.sub("^[a-z]--(code-)?", "", k) or k, "raiz": raiz_de(k, p),
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
        "version": VERSION,
        # Donde el mod deja el index: en la carpeta del usuario, fuera de cualquier repositorio.
        "carpeta_index": os.path.join(os.path.dirname(base), "consumo-index").replace(os.sep, "/"),
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
