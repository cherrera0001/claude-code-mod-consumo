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

1. **Lee** las issues abiertas del repositorio (con el envoltorio de `gh` que el repositorio declara en
   `herramientas.gh`, por ejemplo `scripts/gh-acme.sh`), qué commits
   de `main` nombran cada una, la rama `agente/número` de cada trabajador externo y `.claude/orquestacion.json`.
2. **Clasifica** cada issue en una sola clase: Cierre, Construcción, Interina, Decisión o Épica. Una Decisión
   (`P-*`, `decision-humana`) no se asigna: queda «espera al dueño». Una épica no lleva modelo.
3. **Pesa lo que falta**, no la issue entera. **Primero lee la etiqueta** de la issue, si la trae:
   `peso:XS`, `peso:S`, `peso:M`, `peso:L` o `peso:XL`. Sólo si no hay etiqueta deduce del texto, un punto por
   cada sí: más de una capa; migración, RLS, permisos, sesión o datos personales; la causa no está escrita; hace
   falta navegador o la suite de punta a punta; toca producción o una puerta. La deducción por palabras se pasa
   (da XL a issues de peso M): la etiqueta es de quien leyó la issue. Lo declarado manda sobre las dos cuando
   contesta las cinco preguntas. Una issue con la etiqueta `bloqueada` queda en «espera al dueño», salvo que
   `declarado[n]` diga algo de ella.
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
- Un trabajador externo que lleva **más de 30 minutos sin mover su rama** `agente/número` y **sin nada a
  medias** pasa a «por retomar», y el siguiente despertar se la da al siguiente que esté libre.
- **«A medias» no es «parado».** Si en ese árbol hay ficheros sin confirmar, o entradas en el stash de esa rama,
  la asignación sigue vigente con el motivo «tiene trabajo a medias: preguntar al dueño antes de reasignar».
  El control no reasigna por reloj un trabajo que existe y no está en ningún commit.
- Quien está en `fuera` no recibe nada, y el motivo queda a la vista.
- Agy trabaja en `<raíz>-agy`, rama `agy/<número>`; Codex en `<raíz>-codex`, rama `codex/<número>`. Reciben
  un encargo cerrado: número, criterio de aceptación y archivos que no pueden tocar.
- Empujar `main`, migrar producción y desplegar el API no se delegan.
- Si el candado de suites que el repositorio declara en `herramientas.candado` (por ejemplo `.suite.lock`) está
  tomado, el control lo dice y no lanza ninguna suite pesada.
- Si GitHub no responde, lo dice y enruta sólo la cola escrita; no pesa a ciegas ni da nada por cerrado.

La decisión llega a quien trabaja por dos sitios: el fichero, y una sección del prompt de sistema que
repite la orden vigente. Los cuellos de botella del index **no** van al prompt de sistema (cada cambio rompería
su caché y costaría tokens): van al panel, en una línea. El control sólo actúa en un repositorio que tenga `.claude/orquestacion.json`.

Reinicia Claude Code. El panel se abre solo en terminales anchas; en cualquier ancho, con `/consumo`.

Para desarrollarlo desde una copia local: `claude --plugin-dir <carpeta de este repositorio>`.

## Uso

| Comando | Qué hace |
|---|---|
| `/consumo` | Pinta el panel y devuelve el resumen de la sesión |
| `/consumo avance` | Vuelve a medir issues cerradas y parte de la factura (tarda medio minuto), refresca el index y dice dónde quedó |
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

## Los dos ficheros del control

En la raíz del repositorio de trabajo hay dos ficheros, y sólo uno se versiona:

| Fichero | Quién lo escribe | Se versiona | Qué lleva |
|---|---|---|---|
| `.claude/orquestacion.json` | tú | sí | `cola`, `fuera`, `declarado`, `no_tocar`, `produccion`, `herramientas`, `migraciones` |
| `.claude/orquestacion.local.json` | el control | **no** | `asignaciones`, `clasificacion`, `router`, `reasignado` |

Añade a tu `.gitignore`: `.claude/orquestacion.local.json`. El control no toca el fichero versionado: un árbol
sucio no se despliega, y una decisión que cambia en cada despertar no es historia del repositorio. La única
excepción es una orden tuya, `/consumo fuera`, que declara en `fuera` quién no recibe nada.

Lo que tú escribes, plantilla en [`ejemplos/orquestacion.json`](ejemplos/orquestacion.json):

| Clave | Qué es |
|---|---|
| `cola` | El orden en que se toman las issues |
| `fuera` | Trabajador → motivo |
| `declarado` | Por issue: `clase`, `falta`, `solo_sesion`, las cinco respuestas del peso, y lo que arma la orden: `pasos` (lista ordenada, cada uno con `hecho`), `criterio`, `archivos` y `espera` |
| `no_tocar` | Archivos que un trabajador externo no puede tocar |
| `produccion` | `salud`: la URL de `/health` de la que sale la ficha pública |
| `herramientas` | Lo propio de tu repositorio, con rutas relativas a su raíz: `gh` (el envoltorio con que se habla con GitHub; `.ps1` se lanza con PowerShell y `.sh` con bash), `candado` (el fichero del candado de suites), `migraciones` (la carpeta de migraciones; por defecto `db/migrations`), `incidentes` (el registro de incidentes; por defecto `.claude/incidentes.tsv`) y `dias_rama_antigua` (por defecto 14) |
| `migraciones` | La tabla de reservas de números de migración (ver «El index vivo») |

El mod no trae nombres de ningún producto: si `herramientas.gh` falta, lee las issues con la credencial que
`gh` guarda para la cuenta dueña del repositorio, y lo dice.

El fichero local sólo se reescribe cuando la decisión cambia. Si tu fichero versionado todavía trae
`asignaciones` de una versión anterior, el control las respeta hasta que exista el local; después puedes
borrarlas del versionado.

## El index vivo

El index se actualiza **solo, sin modelo, sin tokens y sin ninguna sesión de Claude abierta**. Lo escribe un
guion de Node estándar, `herramientas/indice.mjs`, que sólo usa `git` en lectura, el disco y, como mucho, cuatro
peticiones HTTP de 5 segundos que nunca lo hacen fallar.

### Instalarlo y quitarlo

```
node herramientas/instalar.mjs --raiz /ruta/a/plataforma --credencial .env:GITHUB_TOKEN
node herramientas/instalar.mjs --desinstalar
```

`--raiz` se repite para varios repositorios; `--cada 2` son los minutos de la tarea; `--credencial`,
`--migraciones` y `--candado` valen para la `--raiz` que tienen delante (antes de la primera, para todas);
`--simular` dice lo que haría sin hacerlo. El instalador:

- copia `indice.mjs` y `diario.mjs` a `~/.claude/consumo-index/` y escribe ahí `repositorios.json` (de la credencial guarda el
  nombre del fichero y el de la variable; **el valor, nunca**);
- pone **dos disparadores**:
  - **hooks de git** (`post-commit`, `post-merge`, `post-checkout`, `post-rewrite`) en el directorio común del
    repositorio, así valen para todos sus worktrees. Lanzan el guion en segundo plano y no bloquean ni hacen
    fallar a git. Un hook que ya existe **no se pisa**: se le añade un bloque entre `# >>> consumo-index` y
    `# <<< consumo-index`, y desinstalar quita sólo ese bloque y lo deja idéntico byte a byte. Respeta
    `core.hooksPath` y lo dice. Un hook existente que no sea de `sh` no se toca;
  - **una tarea programada** cada N minutos: en Windows con `schtasks` (nombre fijo `consumo-index`, lanzada con
    `wscript` y un `.vbs` para que no parpadee ninguna ventana); en Linux y macOS imprime la línea de `crontab`
    y no la instala;
- imprime la línea que hay que pegar en el encargo de un agente que no ejecuta el mod: «Antes de empezar, de
  empujar y de numerar una migración, lee `<repositorio>/.git/consumo/PIZARRA.md`».

`--desinstalar` quita los bloques de los hooks, la tarea, la pizarra y los ficheros copiados, y dice qué hizo en
cada caso. Con una sesión abierta, el mod lanza el mismo guion al empezar y cada dos minutos, y la tercera
pregunta del panel añade una línea con el primer cuello de botella y la ruta del index. Si el guion no está
instalado, el panel dice cómo instalarlo y el mod deja al medir el index de antes (más abajo).

### Qué mide

Por cada repositorio, en unos segundos (51 árboles, 3 s):

- **Árboles y ramas:** de cada worktree, su rama, su último commit, cuántos commits va por delante y por detrás de
  `origin/main`, cuántos **ficheros sin confirmar** y la hora del más reciente, y si esa rama tiene entradas en el
  stash. Los árboles de agentes efímeros (`.claude/worktrees/`) se resumen; sólo salen uno a uno los que tuvieron
  actividad en las últimas 2 horas.
- **Quién:** por la convención de rama `agente/número`; el árbol principal es «sesión principal».
- **Dónde espera el trabajo:** commits escritos y sin llegar a `origin/main` (total, de hoy, por rama y el más
  viejo); los empujes de hoy y **el hueco desde el último**, frente al percentil 95 de los huecos del reflog de
  `origin/main` de ese clon (con su n; con menos de 40 huecos no hay P95 ni aviso). El umbral se calcula una vez
  al día y se guarda en `umbrales.json`: el refresco sólo compara.
- **Remoto movido:** `git ls-remote origin refs/heads/main` frente al `origin/main` local. **Nunca `git fetch`**:
  el guion no ejecuta ninguna orden de git que escriba, y `git status` va con `--no-optional-locks` para no
  competir por el `index.lock` del árbol de otro agente.
- **Migraciones:** el prefijo numérico de cada fichero de la carpeta de migraciones en `origin/main`, en cada
  rama con commits por delante y **en los ficheros sin confirmar de cada árbol**, que es donde un número aparece
  primero. De ahí sale **el siguiente número libre, medido**.
- **Reservas de migración**, si el repositorio las declara:

  ```json
  "migraciones": {
    "_regla": "texto libre",
    "0087": { "issue": 12, "quien": "agente backend", "estado": "escrita, sin integrar", "fichero": "0087_nombre.sql" },
    "0089": { "issue": 34, "quien": "agente backend", "estado": "reservada" },
    "siguiente_libre": "0090"
  }
  ```

- **Candado de suite**, **control** (quién tiene cada issue según lo declarado, su paso sin hacer, quién está
  fuera) e **incidentes de coordinación** (un fichero de una línea por incidente, separado por tabuladores:
  `fecha  hora  causa  coste_min  deteccion  recurso  issue  frase`; la frase no se lee).
- **GitHub**, sólo si el repositorio declara credencial: si está vigente o rechazada, issues abiertas, cerradas
  hoy, cuántas abiertas no pueden avanzar solas (espera declarada, etiqueta de bloqueo, peso XL sin partir) y el
  estado de despliegue del último commit de `main`. Sin credencial, todo eso es **NO MEDIDO**.
- **Producción**, si el repositorio declara `produccion.salud`: commit, salud y si es el de `origin/main`.

Lo que no se pudo medir queda en la página como **NO MEDIDO**, con su motivo. No se rellena con ceros.

### El cálculo diario

Lo que no cabe en un refresco lo hace `herramientas/diario.mjs`, también sin modelo, **como mucho una vez al
día**: lee todas las issues del repositorio (número, fechas, estado y etiquetas; **nunca títulos**) con la
credencial declarada, y el historial de git en sólo lectura, y guarda en `diario.json`:

- la tabla **semana a semana** (creadas, hechas, descartadas, neto), con los **cierres en bloque** aparte: cinco
  o más cierres con diez minutos o menos entre uno y otro son una anotación tardía, no trabajo de ese rato;
- el **tiempo de entrega** de las issues construidas (mediana, P85 y P95, con su n, y cuántas se cerraron a menos
  de una hora de crearse). Cada resumen tiene su n mínimo —10, 20 y 40—; por debajo se dice «insuficiente»;
- las issues **hechas sin ningún commit** que las nombre;
- los **commits sin integrar al cierre de cada día**;
- la **proyección de la cola**, sólo con 8 semanas completas o más y sólo si no cambia de rango al quitar una
  semana. Con menos, NO MEDIDO y la razón. La simulación usa una semilla fija.

El refresco lee el `diario.json` que haya y dice su fecha. Si falta o tiene más de 20 horas, lo lanza él mismo
**en segundo plano y sin esperarlo** (como mucho un intento cada media hora); a mano, `node indice.mjs --diario`.
Sin credencial declarada no hay cálculo diario y esas secciones siguen en NO MEDIDO. El umbral de los huecos
entre empujes sale de una sola función y se guarda en `umbrales.json`; el cálculo diario lo cita.

### Los cuellos de botella

Van arriba del todo, en `index.json` (`cuellos`, con `gravedad`, `que`, `desde` y `repositorio`) y en la página.

| Gravedad | Cuello | Cuándo salta |
|---|---|---|
| alta | credencial rechazada | GitHub responde 401 a la credencial declarada |
| alta | migración | el mismo número con ficheros de nombre distinto en dos sitios (ramas, árboles o `main`), o un número en uso cuya reserva no existe o es de otra issue. **Un solo aviso por número**, con todo en una frase |
| alta | `siguiente_libre` que no es libre | el declarado es menor o igual que un número ya usado o reservado |
| alta | remoto movido | el remoto movió `main` y hay un árbol con trabajo debajo |
| alta | hueco de integración | más tiempo sin empujes que el P95 de los huecos, con commits de hoy esperando |
| alta | sin despliegue | el último commit de `main` lleva más de 10 min sin despliegue, o el despliegue falló |
| alta | producción | corre otro commit que `main`, o responde con problemas |
| media o alta | issue en dos árboles | una issue con trabajo en dos árboles: es una pregunta («confirmar que el reparto es intencionado»). Sólo es alta si los dos tocaron los mismos ficheros y ninguna rama contiene a la otra; entonces lista hasta tres |
| media | pieza sin integrar | rama con commits por delante, árbol limpio y último commit hace más de 30 min. En el árbol principal sólo cuentan los commits de hoy |
| media | trabajo sin confirmar | ficheros sin confirmar y último commit hace más de 30 min |
| media | stash | una rama con entradas en el stash (si esa rama ya avisa por otra cosa, va en la misma frase) |
| media | reserva vacía | una reserva en estado «reservada» sin fichero en ningún sitio tras 2 horas |
| media | lo declarado está caducado | una `espera` declarada cuya rama ya llegó a `origin/main` |

**Ramas antiguas.** Una rama o un árbol cuyo último commit tiene más de 14 días (`herramientas.dias_rama_antigua`)
y que no es la de una asignación vigente del control **no genera ningún aviso** ni sale en la tabla: va a una
lista cerrada al final del panel, una línea por rama con su antigüedad. La edad del fichero del control tampoco
avisa: el control sólo reescribe cuando su decisión cambia, y la edad sola no indica nada.

**«Trabajo sin confirmar» no significa «parado».** Git sabe que hay ficheros modificados y cuándo se tocó el
último; no sabe si alguien está escribiendo. El index lo dice así —«tiene trabajo sin confirmar», «tiene trabajo
a medias»— y nunca «inactivo». Por la misma razón el control no reasigna por reloj a quien tiene trabajo a medias.

### Qué es privado y qué se puede publicar

| Salida | Dónde | Qué lleva | Qué no lleva |
|---|---|---|---|
| **Index**, privado | `~/.claude/consumo-index/index.html` e `index.json` | números de issue, ramas, trabajadores, nombres de fichero, asuntos de commit | títulos de issues, el contenido de ningún fichero, el valor de ninguna credencial |
| **Pizarra**, privada | `<git-common-dir>/consumo/PIZARRA.md` y `pizarra.json` en cada repositorio (dentro de `.git`: no se versiona y la ven todos los worktrees) | hora de la foto, `origin/main` y cuándo se movió, quién verifica o integra, el siguiente número de migración libre y los tomados, quién está en qué issue, las alertas rojas y las dos órdenes de git para medirlo uno mismo | títulos de issues |
| **Ficha de producción**, pública | `~/.claude/consumo-index/produccion-<nombre>.html` y `.json` | el commit publicado y si el servicio está bien | todo lo demás |

La página (`index.html`) es autocontenida: los datos van incrustados, sin `fetch`, sin estilos ni fuentes
externas, y se recarga sola cada 30 segundos. Su único guion lee la hora incrustada y escribe la edad de la
foto; si pasa de 10 minutos, avisa arriba del todo de que **el index no se está actualizando**.

### El index de antes, sin el guion instalado

Si el guion no está instalado, cada vez que el mod mide el avance (al abrir la sesión, cada media hora y con
`/consumo avance`) deja la foto de siempre: **una ficha por repositorio que entra en el reparto de la factura**. Cada ficha dice, y sólo dice:

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
escribe `.claude/orquestacion.json`, su fichero local y, el guion del index, la pizarra dentro de `.git/consumo/`.
La credencial de GitHub que declares para el index se lee del fichero en cada corrida, viaja sólo a
`api.github.com` y no se imprime, no se guarda y no aparece en ningún error. Guarda una caché de la última medición de avance en la carpeta temporal
del sistema y el index en `~/.claude/consumo-index`, fuera de cualquier repositorio. Los tokens de `gh` viajan
sólo en el entorno del proceso.

## Desarrollo

```
claude plugin validate .
claude plugin test .
node --test herramientas/indice.test.mjs herramientas/instalar.test.mjs herramientas/diario.test.mjs
```

Las pruebas de `herramientas/` crean sus repositorios en una carpeta temporal (un remoto local desnudo, árboles de
agentes, ramas `agy/12` y `codex/34`), no tocan la red ni crean tareas programadas. Lo que `herramientas/indice.mjs`
porta de `hooks/indice.ts` tiene una prueba que compara las dos salidas sobre el mismo estado.

La decisión (`hooks/router.ts`) y el index (`hooks/indice.ts`) no tienen entrada ni salida: todo lo que toca
disco, procesos o el almacén vive en `hooks/register.tsx`.

Los tres guiones de `hooks/*.py` van además embebidos, tal cual, dentro de `hooks/register.tsx` (el
módulo no conoce su propia carpeta y los ejecuta por la entrada estándar). Al cambiar uno hay que
cambiar los dos; no llevan barras invertidas ni acentos graves por eso mismo.
