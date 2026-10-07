# consumo — tablero de consumo y avance real para Claude Code

Un *mod* (plugin de hooks) de Claude Code que abre un panel dentro de la sesión y responde a una
pregunta que el costo por token no contesta: **¿cuánto trabajo real salió de lo que se gastó?**

Cruza tres fuentes que ya están en la máquina —las transcripciones locales de Claude Code, `git` y
`gh`— y no envía nada a ningún servicio propio.

```
Consumo · sesión de 5 h 47 min · motor 163.27 USD · estimado 195.47 USD · 15:05
Tanque de contexto    ███████████████████░░░░░ 79 % · 786k de 1.0M
Presupuesto 200 USD   ████████████████████░░░░ 82 % · 163.27 USD
Ritmo (última hora)   ▃▁▁▁▁▁▁▁▂▃▄█ 16.8 USD/h · 8.41 USD en 30 min
Autonomía             2 h 11 min hasta el presupuesto, al ritmo actual

Avance real · dueno/repositorio · desde el 07-09 · 14:48
Issues: 188 cerradas · 10 descartadas · 216 creadas · 18 abiertas hoy
Factura de 238 USD: este proyecto ≈ 112 USD (47 %) · ≈ 0.60 USD por issue cerrada
28-09  55 cerradas ·  74 creadas ·  51 abiertas · ███░░░░░  41 USD
05-10  56 cerradas ·  28 creadas ·  18 abiertas · ██░░░░░░  22 USD
Iteración: 68 despertares del bucle, 23 sin cambios · 130 subagentes (38.7 % del consumo)

Orquestación · 2 agentes externos (1 activos) · 8 subagentes de la sesión (1 activos)
activo   agy      #345 · 3 commits · última actividad hace 2 min
FUERA    codex    #344 · 5 commits · sin cuota · reasignada a claude
Por redistribuir: #314 (su agente está inactivo o fuera y nadie las tomó)
```

## Integrarlo a tu repositorio en cinco pasos

La unidad de medida es simple: **issues cerradas por semana frente a lo que costó cerrarlas.** Para que
el tablero la pueda calcular sobre tu repositorio hacen falta estas cinco cosas.

**1. Trabaja con issues.** Cada tarea es una issue de GitHub en el repositorio. Lo que no es una issue
no se cuenta. Una issue que se descarta se cierra como «not planned»: el tablero la separa de las
hechas.

**2. Abre Claude Code dentro del repositorio.** El mod toma el repositorio del remoto `origin`
(`git remote get-url origin`) y el consumo, de las transcripciones de Claude Code de esa carpeta. Si
trabajas con varios repositorios, cada carpeta es un proyecto distinto y la factura se reparte entre
todos.

**3. Deja `gh` autenticado** con una cuenta que pueda leer las issues: `gh auth login`. Si usas varias
cuentas, el mod pide el token de la cuenta dueña del repositorio (`gh auth token --user <dueño>`) sin
cambiar tu cuenta activa; con la opción `cuentaGitHub` eliges otra.

**4. Instala el mod y dile cuánto pagas.**

```
/plugin marketplace add cherrera0001/claude-code-mod-consumo
/plugin install consumo@consumo-local
```

Al instalar pide `facturaMensualUsd` (lo que pagas al mes por Claude) y `presupuestoUsd` (cuánto
quieres gastar por sesión). Reinicia Claude Code.

**5. Mide.** `/consumo avance` recorre las transcripciones y las issues y pinta, semana por semana,
cuántas se cerraron y cuánto de la factura se llevó el proyecto. Tarda medio minuto la primera vez;
después guarda la última medición y la enseña al abrir la sesión.

### Si trabajas con más de un agente

Para que la sección «Orquestación» sepa quién hace qué, basta una convención y, opcionalmente, un
fichero:

- Cada agente trabaja en su propia rama con la forma **`agente/número-de-issue`** (`codex/344`,
  `agy/345`), idealmente en su propio `git worktree`. El mod deduce de ahí quién es, en qué issue está y
  hace cuánto fue su última actividad.
- Lo que `git` no puede saber —que un agente se quedó sin cuota, o a quién se reasignó una issue— se
  escribe en `.claude/orquestacion.json`, en la raíz de tu repositorio. Hay una plantilla en
  [`ejemplos/orquestacion.json`](ejemplos/orquestacion.json).

### Qué mirar cada semana

| Señal en el tablero | Qué significa | Qué hacer |
|---|---|---|
| «Esta semana: ≈ N USD de consumo y ninguna issue cerrada» (en rojo) | Se gastó y no se cerró nada | Revisar qué quedó a medias: suele ser trabajo hecho y sin cerrar, o iteración sin salida |
| «El tablero no se vacía, crece» | Se abren más issues de las que se cierran | Dejar de abrir, o partir menos fino |
| «N despertares del bucle, M sin cambios» con M alto | El bucle despierta para no hacer nada | Espaciar los despertares o dejar que avise el trabajo en segundo plano |
| «subagentes (X % del consumo)» muy alto | Se delega más de lo que rinde | Delegar sólo lo que se puede describir bien |
| «releer contexto X %» muy alto | Sesiones largas que releen su historia | Cerrar la sesión al cambiar de tema |
| «Por redistribuir: #N» (en rojo) | Una issue tiene dueño inactivo o fuera | Reasignarla y anotarlo en `.claude/orquestacion.json` |

## Qué mide

| Sección | Qué dice | De dónde sale |
|---|---|---|
| **Consumo** | Duración de la sesión, costo según el motor y estimado, contexto ocupado, presupuesto gastado, ritmo de la última hora y autonomía al ritmo actual | La transcripción de la sesión y `$.session.usage()` |
| **Avance real** | Issues cerradas, creadas y abiertas por semana; qué parte de la factura mensual consume este proyecto; costo por issue cerrada; proyección de cuándo se vacía el tablero; despertares de bucle vacíos y peso de los subagentes | Todas las transcripciones de `~/.claude/projects` y `gh issue list` |
| **Orquestación** | Qué agentes trabajan en el repositorio, en qué issue, cuál está activo, inactivo o fuera, y qué issues quedaron sin dueño | `git worktree`, ramas `agente/issue` y `.claude/orquestacion.json` |
| **Ahora** | La tarea en curso y el próximo despertar del bucle | La transcripción |
| **Pendiente en GitHub** | Issues y PR abiertos | `gh` |
| **Por modelo / Tareas anteriores** | Llamadas, tokens y costo estimado por modelo, por tarea y por subagente | La transcripción y las de sus subagentes |
| **Cobertura** | Porcentaje de `pytest --cov`; se oculta donde no hay pytest | `coverage` |

### Cómo leer las cifras

- **«Estimado» es precio de lista**, calculado desde los tokens de la transcripción; «motor» es lo que
  informa Claude Code. Ninguno es la factura.
- **La parte de la factura es un reparto, no una medición de cobro:** el consumo de todos los proyectos
  de la máquina se pondera por modelo y la factura mensual configurada se reparte en esa proporción.
- **Un mismo mensaje aparece en varias líneas de la transcripción** con el mismo uso. Se cuenta una vez
  por `message.id`; sin eso el total se infla unas 2,7 veces.
- **«Issues cerradas» no distingue tamaño.** Sirve para ver tendencia y semanas con consumo y sin
  cierres, no para comparar personas.

## Requisitos

- Claude Code con soporte de mods (plugins de hooks).
- `python` 3.10 o superior en el `PATH` (o un `.venv` en la raíz del proyecto).
- `git`, y `gh` autenticado con acceso al repositorio que se mide.

## Instalación

```
/plugin marketplace add cherrera0001/claude-code-mod-consumo
/plugin install consumo@consumo-local
```

Reinicia Claude Code. El panel se abre solo en terminales anchas; en cualquier ancho, con `/consumo`.

Para desarrollarlo desde una copia local: `claude --plugin-dir <carpeta de este repositorio>`.

## Uso

| Comando | Qué hace |
|---|---|
| `/consumo` | Abre el panel y devuelve el resumen de la sesión |
| `/consumo avance` | Vuelve a medir issues cerradas y parte de la factura (tarda medio minuto) |
| `/consumo agentes` | Quién trabaja en el repositorio y qué hay que redistribuir |
| `/consumo github` | Relee issues y PR abiertos |
| `/consumo cobertura` | Corre `pytest --cov` (sólo donde hay pytest) |

## Configuración

Se pide al instalar y se cambia en `/plugin`:

| Opción | Para qué | Por defecto |
|---|---|---|
| `facturaMensualUsd` | Lo que pagas al mes; se reparte entre los proyectos de la máquina | 238 (un ejemplo: pon la tuya) |
| `presupuestoUsd` | Presupuesto de la sesión, para la barra y la autonomía | 200 |
| `repo` | `dueño/nombre` del repositorio de issues | el remoto `origin` |
| `cuentaGitHub` | Cuenta de `gh` con la que se consulta | la dueña del repositorio |

## Orquestación entre agentes

El mod reconoce a un agente externo por su rama: `codex/344`, `agy/345`. Deduce de `git` si sigue
activo (último commit o fichero tocado hace menos de 30 minutos). Lo que `git` no puede saber se
declara en `.claude/orquestacion.json`, en el repositorio que se mide:

```json
{
  "fuera": { "codex": "sin cuota de tokens desde el 07-10" },
  "reasignado": { "344": "claude", "314": "claude" }
}
```

Una issue cuyo agente está inactivo o fuera, y que nadie reasignó, sale en rojo como «por redistribuir».

## Privacidad

Sólo lee: las transcripciones de `~/.claude/projects`, el repositorio local y lo que `gh` devuelve con
tu propia sesión. No escribe en el repositorio ni en GitHub. Guarda una caché de la última medición de
avance en la carpeta temporal del sistema. Los tokens de `gh` viajan sólo en el entorno del proceso.

## Desarrollo

```
claude plugin validate .
claude plugin test .
```

Los tres guiones de `hooks/*.py` van además embebidos, tal cual, dentro de `hooks/register.tsx` (el
módulo no conoce su propia carpeta y los ejecuta por la entrada estándar). Al cambiar uno hay que
cambiar los dos; no llevan barras invertidas ni acentos graves por eso mismo.
