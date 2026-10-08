# consumo — mide, gestiona y controla el trabajo en Claude Code

Un *mod* (plugin de hooks) de Claude Code que abre un panel dentro de la sesión y responde a una
pregunta que el costo por token no contesta: **¿cuánto trabajo real salió de lo que se gastó?**

Cruza tres fuentes que ya están en la máquina —las transcripciones locales de Claude Code, `git` y
`gh`— y no envía nada a ningún servicio propio.

```
1 · ¿Cuánto queda de presupuesto y de contexto? · sesión de 5 h 47 min · 15:05
Presupuesto 200 USD   ████████████████████░░░░ quedan 36.73 USD (gastado el 82 %)
Tanque de contexto    ███████████████████░░░░░ queda libre el 21 % · ocupados 786k de 1.0M
Ritmo (última hora)   ▂▃▅▇▆▃▂▁▁▂▃▂ 28.4 USD/h
Autonomía             1 h 17 min hasta el presupuesto, al ritmo actual

2 · ¿Esta semana se cierra trabajo o sólo se gasta? · Avance real · acme/plataforma
Sólo se gasta. Esta semana: ≈ 11 USD de consumo y ninguna issue cerrada (21 creadas)
Issues: 132 cerradas · 5 descartadas · 209 creadas · 72 abiertas hoy

3 · ¿Quién tiene cada issue y qué va a hacer el próximo despertar? · decidido 15:04
Esta sesión tiene la #333 (Cierre), peso L, esfuerzo muy alto. El próximo despertar sigue con ella y no toma otra.
Agy tiene la #346 (Construcción), peso M, esfuerzo alto. El próximo despertar la deja donde está si la rama agy/346 se movió en los últimos 30 minutos; si no, la marca por retomar.
En cola: #342, #343. Espera al dueño: #325.
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

Para que el control sepa quién hace qué, basta una convención y un fichero:

- Cada agente trabaja en su propia rama con la forma **`agente/número-de-issue`** (`codex/344`,
  `agy/345`), idealmente en su propio `git worktree`. El mod deduce de ahí quién es, en qué issue está y
  hace cuánto fue su última actividad.
- Lo que `git` no puede saber —que un agente se quedó sin cuota, o a quién se reasignó una issue— se
  escribe en `.claude/orquestacion.json`, en la raíz de tu repositorio. Hay una plantilla en
  [`ejemplos/orquestacion.json`](ejemplos/orquestacion.json).

### Qué hace el control cuando despierta

En `session.start` y en cada despertar del bucle (`/loop`), antes de que nadie empiece, el hook:

1. **Lee** las issues abiertas del repositorio (con `scripts/gh-vt.ps1` del propio repositorio), qué commits
   de `main` nombran cada una, la rama `agente/número` de cada trabajador externo y `.claude/orquestacion.json`.
2. **Clasifica** cada issue en una sola clase: Cierre, Construcción, Interina, Decisión o Épica. Una Decisión
   (`P-*`, `decision-humana`) no se asigna: queda «espera al dueño». Una épica no lleva modelo.
3. **Pesa lo que falta**, no la issue entera. Un punto por cada sí: más de una capa; migración, RLS, permisos,
   sesión o datos personales; la causa no está escrita; hace falta navegador, `pnpm e2e` o `pnpm gate`; toca
   producción o una puerta.
4. **Asigna, reasigna o se detiene**, y lo escribe en `.claude/orquestacion.json`:

| Puntos | Peso | Esfuerzo | Quién lo hace |
|---|---|---|---|
| 0 | XS | bajo | esta sesión |
| 1 | S | medio | esta sesión |
| 2 | M | alto | esta sesión, o Agy si esta sesión está desplegando |
| 3 | L | muy alto | Claude construye; Agy o Codex, el que esté libre, revisa en sólo lectura |
| 4–5 | XL | máximo, con plan antes | no se asigna entera: se parte en pesos L o M |

El control **no asigna modelo**: el modelo es el de la sesión y se lee. El dial es el esfuerzo.

5. **Le da al despertar sólo la orden.** Cuando el bucle despierta (`scheduled-trigger`), al modelo no le llega
   el prompt del bucle: le llega la issue que tiene esta sesión, **su primer paso sin hacer**, el criterio y los
   archivos. El paso no se inventa: sale de `declarado[n].pasos` del fichero, y alguien lo marca `hecho`; el
   hook no lo da por hecho. Sin pasos o con todos hechos, la orden es **parar**: no se recorre el tablero ni se
   abren issues. Si la issue tiene `espera` escrito, la orden es la de la siguiente de esta sesión que no
   espere; sólo si todas esperan se para, con el motivo. Si el control falla, entra el prompt original: un despertar no se
   pierde. La misma orden, en pocas líneas, va en el prompt de sistema.

Reglas que el control no negocia:

- **Un trabajador, una issue.** Una asignación vigente no se reasigna.
- **La que espera al dueño no ocupa a nadie.** Una asignación cuya issue tiene `declarado[n].espera` escrito
  sigue siendo de su trabajador y sigue a la vista, pero no lo retiene (ni a su revisor): el control le da la
  siguiente de la cola, y la cola no se queda entera detrás de una credencial que falta. Tampoco pasa a «por
  retomar» por inactividad. Al borrar `espera`, vuelve a ser la primera de su trabajador.
- Un trabajador externo que lleva **más de 30 minutos sin mover su rama** `agente/número` pasa a «por
  retomar», y el siguiente despertar se la da al siguiente que esté libre.
- Quien está en `fuera` no recibe nada, y el motivo queda a la vista.
- Agy trabaja en `<raíz>-agy`, rama `agy/<número>`; Codex en `<raíz>-codex`, rama `codex/<número>`. Reciben
  un encargo cerrado: número, criterio de aceptación y archivos que no pueden tocar.
- Empujar `main`, migrar producción y desplegar el API no se delegan.
- Si `.vt-suite.lock` está tomado, el control lo dice y no lanza `verify`, `gate` ni `e2e`.
- Si GitHub no responde, lo dice y enruta sólo la cola escrita; no pesa a ciegas ni da nada por cerrado.

La decisión llega a quien trabaja por dos sitios: el fichero, y una sección del prompt de sistema que
repite la orden vigente. El control sólo actúa en un repositorio que tenga `.claude/orquestacion.json`.

Reinicia Claude Code. El panel se abre solo en terminales anchas; en cualquier ancho, con `/consumo`.

Para desarrollarlo desde una copia local: `claude --plugin-dir <carpeta de este repositorio>`.

## Uso

| Comando | Qué hace |
|---|---|
| `/consumo` | Pinta el panel y devuelve el resumen de la sesión |
| `/consumo avance` | Vuelve a medir issues cerradas y parte de la factura (tarda medio minuto), regenera el index y dice dónde quedó |
| `/consumo agentes` | Ejecuta el control y responde con una frase por issue: quién, número, peso y qué hará el próximo despertar |
| `/consumo fuera <agy\|codex> <motivo>` | Saca a ese trabajador y mueve su issue |
| `/consumo tomar <número> <agy\|codex\|claude>` | Reasigna a mano y lo anota en la issue con una línea |
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

## El fichero del control

`.claude/orquestacion.json`, en la raíz del repositorio de trabajo, es donde el control escribe y donde
se le dice lo que `git` y GitHub no saben. Plantilla: [`ejemplos/orquestacion.json`](ejemplos/orquestacion.json).

| Clave | Quién la escribe | Qué es |
|---|---|---|
| `cola` | tú | El orden en que se toman las issues |
| `fuera` | tú o `/consumo fuera` | Trabajador → motivo |
| `declarado` | tú | Por issue: `clase`, `falta`, `solo_sesion`, las cinco respuestas del peso, y lo que arma la orden: `pasos` (lista ordenada, cada uno con `hecho`), `criterio`, `archivos` y `espera` |
| `no_tocar` | tú | Archivos que un trabajador externo no puede tocar |
| `asignaciones` | el control | Issue → trabajador, clase, peso, esfuerzo, estado y encargo |
| `clasificacion` | el control | Todas las issues leídas, con su situación |
| `router` | el control | Si GitHub respondió y qué anotaciones quedaron pendientes |
| `produccion` | tú | `{ "salud": "<url de /health>" }`: de dónde sale la ficha pública de producción. Sin ella no hay ficha |

El fichero sólo se reescribe cuando la decisión cambia.

## El index

Cada vez que el mod mide el avance (al abrir la sesión, cada media hora y con `/consumo avance`) deja además
una foto: **una ficha por repositorio que entra en el reparto de la factura**. Cada ficha dice, y sólo dice:

- la issue en curso de esa sesión (su número) y quién la tiene;
- el paso sin hacer —el primero de `declarado[n].pasos` sin `hecho`—, o **«no hay paso»**;
- qué hizo el último despertar del bucle: **cerró algo** (encontró más pasos hechos que el despertar anterior),
  **dio una orden** o **paró**;
- la hora de la foto.

Sale del `.claude/orquestacion.json` de cada repositorio; el que no lo tiene aparece como «sin control» y nada
más. Lo del último despertar lo anota el hook en el almacén del propio mod, no en ese fichero, que está
versionado y sólo se reescribe cuando la decisión cambia.

Son dos salidas, y las arman dos funciones distintas (`hooks/indice.ts`), no un filtro sobre el mismo objeto:

| Salida | Dónde | Qué lleva | Qué no lleva |
|---|---|---|---|
| **Index de tareas**, privado | `~/.claude/consumo-index/index.html` e `index.json` | número de issue, quién la tiene, el paso, el último despertar | títulos de issues, la cola |
| **Ficha de producción**, pública | `~/.claude/consumo-index/produccion-<nombre>.html` y `.json` | el commit publicado y si el servicio está bien | issues, pasos, nombres, cola: nada del backlog |

La ficha de producción sólo existe para el repositorio que declare en su `.claude/orquestacion.json`:

```json
"produccion": { "salud": "https://ejemplo.invalid/health" }
```

El mod pide esa URL con `curl` y la ficha se arma **únicamente** con lo que responde: el campo `commit` (si es
un SHA; cualquier otra cosa sale como «no publicado», nunca reflejada) y si `status` o `estado` dicen `ok`. La
función que la construye recibe `{ commit, bien, cuando }` y nada más: no recibe el estado de orquestación, así
que no puede filtrar backlog ni por descuido. Por eso se puede copiar a un sitio público; el index de tareas, no.

La página muestra la foto. No reasigna, no despliega y no sustituye al hook: es HTML estático, sin guiones y
sin estilos externos.

## Privacidad

Sólo lee: las transcripciones de `~/.claude/projects`, el repositorio local, lo que `gh` devuelve con
tu propia sesión y, si la declaras, la URL de salud. No escribe en GitHub, y en el repositorio de trabajo sólo
escribe `.claude/orquestacion.json`. Guarda una caché de la última medición de avance en la carpeta temporal
del sistema y el index en `~/.claude/consumo-index`, fuera de cualquier repositorio. Los tokens de `gh` viajan
sólo en el entorno del proceso.

## Desarrollo

```
claude plugin validate .
claude plugin test .
```

La decisión (`hooks/router.ts`) y el index (`hooks/indice.ts`) no tienen entrada ni salida: todo lo que toca
disco, procesos o el almacén vive en `hooks/register.tsx`.

Los tres guiones de `hooks/*.py` van además embebidos, tal cual, dentro de `hooks/register.tsx` (el
módulo no conoce su propia carpeta y los ejecuta por la entrada estándar). Al cambiar uno hay que
cambiar los dos; no llevan barras invertidas ni acentos graves por eso mismo.
