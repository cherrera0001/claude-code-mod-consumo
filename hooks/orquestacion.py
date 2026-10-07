from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Orquestacion: quienes estan trabajando en este repositorio, en que, y quien quedo fuera.
# Solo lee: git (arboles de trabajo y ramas), el fichero .claude/orquestacion.json del proyecto y las
# transcripciones de los subagentes de la sesion. Fuente en ASCII y sin barras invertidas: va embebida.
#
# Convencion: un agente externo trabaja en una rama <agente>/<issue> (codex/344, agy/345), en su propio
# arbol de trabajo. El estado se deduce de la actividad; "fuera" se declara en .claude/orquestacion.json:
#   {"fuera": {"codex": "sin cuota desde el 07-10"}, "reasignado": {"314": "claude"}}

NO_SON_AGENTES = {"fix", "feat", "feature", "ci", "chore", "docs", "hotfix", "release", "integracion",
                  "test", "refactor", "bugfix", "agents", "worktree", "dependabot", "renovate", "revert"}
ACTIVO_S = 30 * 60
VIGENTE_S = 7 * 24 * 3600
SUBAGENTE_ACTIVO_S = 10 * 60


def arg(nombre, defecto=""):
    return sys.argv[sys.argv.index(nombre) + 1] if nombre in sys.argv else defecto


def git(raiz, *a):
    try:
        r = subprocess.run(["git", "-C", raiz, *a], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=25)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


def agente_de(rama):
    m = re.match("^([A-Za-z][A-Za-z0-9_-]*)/([0-9]+)", rama)
    if not m or m.group(1).lower() in NO_SON_AGENTES:
        return None
    return m.group(1).lower(), int(m.group(2))


def entero(texto, defecto=0):
    try:
        return int(texto.strip())
    except Exception:
        return defecto


def actividad_del_arbol(ruta, ultimo_commit):
    # Lo mas reciente entre el ultimo commit y los ficheros con cambios sin confirmar.
    reciente = ultimo_commit
    sucios = 0
    for linea in git(ruta, "status", "--porcelain").splitlines():
        sucios += 1
        if sucios > 60:
            continue
        nombre = linea[3:].strip().strip(chr(34))
        if " -> " in nombre:
            nombre = nombre.split(" -> ")[-1]
        try:
            reciente = max(reciente, os.path.getmtime(os.path.join(ruta, nombre)))
        except OSError:
            pass
    return reciente, sucios


def main():
    raiz = arg("--raiz", os.getcwd())
    sesion = arg("--sesion")
    cwd = arg("--cwd", raiz)
    ahora = time.time()
    base = git(raiz, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").strip() or "origin/main"

    declarado = {}
    try:
        declarado = json.load(open(os.path.join(raiz, ".claude", "orquestacion.json"), encoding="utf-8"))
    except Exception:
        declarado = {}
    fuera = {str(k).lower(): str(v) for k, v in (declarado.get("fuera") or {}).items()}
    reasignado = {str(k): str(v) for k, v in (declarado.get("reasignado") or {}).items()}

    filas = {}

    def anotar(nombre, issue, rama, ruta):
        ultimo = entero(git(raiz, "log", "-1", "--format=%ct", rama), 0)
        commits = entero(git(raiz, "rev-list", "--count", base + ".." + rama), 0)
        reciente, sucios = (ultimo, 0)
        if ruta:
            reciente, sucios = actividad_del_arbol(ruta, ultimo)
        if not reciente or ahora - reciente > VIGENTE_S:
            return
        clave = nombre + "/" + str(issue)
        previa = filas.get(clave)
        if previa and previa["ultima"] >= reciente and not ruta:
            return
        filas[clave] = {"nombre": nombre, "issue": issue, "rama": rama, "commits": commits, "sin_confirmar": sucios,
                        "ultima": reciente or None, "con_arbol": bool(ruta)}

    bloque = {}
    for linea in git(raiz, "worktree", "list", "--porcelain").splitlines() + [""]:
        if linea.startswith("worktree "):
            bloque = {"ruta": linea[9:].strip()}
        elif linea.startswith("branch "):
            bloque["rama"] = linea[7:].strip().replace("refs/heads/", "")
        elif not linea.strip() and bloque:
            quien = agente_de(bloque.get("rama", ""))
            if quien:
                anotar(quien[0], quien[1], bloque["rama"], bloque.get("ruta", ""))
            bloque = {}

    for rama in git(raiz, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin").splitlines():
        corta = rama.strip()[len("origin/"):] if rama.strip().startswith("origin/") else rama.strip()
        quien = agente_de(corta)
        if quien and (quien[0] + "/" + str(quien[1])) not in filas:
            anotar(quien[0], quien[1], rama.strip(), "")

    agentes = []
    for f in sorted(filas.values(), key=lambda x: (x["nombre"], x["issue"])):
        hace = (ahora - f["ultima"]) if f["ultima"] else None
        if f["nombre"] in fuera:
            estado, motivo = "fuera", fuera[f["nombre"]]
        elif hace is not None and hace < ACTIVO_S:
            estado, motivo = "activo", ""
        else:
            estado, motivo = "inactivo", ""
        agentes.append(dict(f, estado=estado, motivo=motivo,
                            hace_min=round(hace / 60, 1) if hace is not None else None,
                            reasignado_a=reasignado.get(str(f["issue"]), "")))
    # Quien esta declarado fuera aunque no tenga rama a la vista.
    for nombre, motivo in fuera.items():
        if not any(a["nombre"] == nombre for a in agentes):
            agentes.append({"nombre": nombre, "issue": None, "rama": "", "commits": 0, "sin_confirmar": 0, "ultima": None,
                            "con_arbol": False, "estado": "fuera", "motivo": motivo, "hace_min": None, "reasignado_a": ""})

    subagentes = []
    if sesion:
        codificada = "".join(c if (c.isascii() and c.isalnum()) else "-" for c in cwd)
        carpeta = os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".claude", "projects",
                               codificada, sesion, "subagents")
        for ruta in sorted(glob.glob(os.path.join(carpeta, "agent-*.jsonl")), key=os.path.getmtime):
            etiqueta = ""
            try:
                meta = json.load(open(ruta[:-len(".jsonl")] + ".meta.json", encoding="utf-8"))
                for clave in ("description", "agentType", "subagent_type", "name"):
                    if isinstance(meta.get(clave), str) and meta[clave].strip():
                        etiqueta = " ".join(meta[clave].split())[:48]
                        break
            except Exception:
                pass
            hace = ahora - os.path.getmtime(ruta)
            subagentes.append({"etiqueta": etiqueta or os.path.basename(ruta)[6:14], "hace_min": round(hace / 60, 1),
                               "activo": hace < SUBAGENTE_ACTIVO_S})

    por_redistribuir = sorted({a["issue"] for a in agentes
                               if a["issue"] is not None and a["estado"] != "activo" and not a["reasignado_a"]})
    print(json.dumps({
        "ahora": ahora,
        "agentes": agentes,
        "externos": len({a["nombre"] for a in agentes}),
        "externos_activos": len({a["nombre"] for a in agentes if a["estado"] == "activo"}),
        "subagentes": {"total": len(subagentes), "activos": sum(1 for s in subagentes if s["activo"]),
                       "ultimos": subagentes[-4:]},
        "por_redistribuir": por_redistribuir,
    }, ensure_ascii=False))


main()
