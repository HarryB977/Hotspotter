# 08 · Distribución y actualizaciones

Decidido con el usuario:

- El código vive en un **repositorio público de GitHub** (`HarryB977/Hotspotter`, licencia MIT; decisión 100). Empezó privado con un token incrustado; se hizo público el 2026-11-17, antes del primer release.
- Los compañeros descargan un **release portable**: una carpeta (o zip) con `hotspotter.exe`. Sin instalador.
- La app **avisa** cuando hay una versión nueva en el repositorio.
- La consulta de versiones va **sin token**. El soporte de token sigue en el código por si el repo volviera a ser privado (ver «Token opcional»).

## Portable

- `hotspotter.exe` abre una **ventana de consola** (sin icono en la bandeja; decisión 90) y arranca el servidor local en el puerto **7420**, o en uno libre si está ocupado (decisión 91). Abre la app en Chrome o Edge: el navegador por defecto si es uno de los dos, y si no el que esté instalado; si no hay ninguno, lo explica en la consola. Cerrar la ventana cierra Hotspotter. `HOTSPOTTER_NO_BROWSER=1` no abre el navegador.
- **Segunda copia** (decisión 92): el `.exe` consulta `/api/health` de la copia que ya está en marcha (`instance.json` en la carpeta de datos). Si es de la misma versión, abre esa en el navegador; si es de otra, avisa en la consola, espera Intro y sale.
- Empaquetado (decisión 95): `npm run portable` (`scripts/build-portable.mjs`) genera con esbuild un bundle CJS del lanzador y lo convierte en una Node 22 Single Executable Application con postject. Sale `dist/portable/Hotspotter/hotspotter.exe` (unos 83 MB) y, junto a él, la carpeta `web/` con el frontend; el zip pesa unos 32 MB. El `.exe` no está firmado: SmartScreen avisa la primera vez.
- Los datos del usuario (librería de materiales, ajustes, sidecar y modelos de IA) se guardan en una carpeta de datos (por defecto `%LOCALAPPDATA%\Hotspotter`, o `HOTSPOTTER_DATA_DIR` si está definida; hoy contiene `updates.json`, `instance.json` y `hotspotter.log`), no junto al `.exe`, para que sustituir la carpeta del portable al actualizar no borre nada.
- Solo Windows en v1.

## Comprobación de actualizaciones

- Al cargar la app (y como mucho una vez cada 6 horas, decisión 93) el **servidor**, no el navegador, consulta la API de releases de GitHub del repo, sin autenticar (60 peticiones por hora e IP, de sobra con una cada 6 horas).
- Si la versión publicada (semver en el tag) es mayor que la local, la UI muestra un aviso discreto con las notas del release y un botón que abre la página de descarga. El usuario puede posponerlo u omitir esa versión.
- No se descarga ni se reemplaza nada automáticamente en v1.
- Solo cuentan las versiones estables (`vX.Y.Z`); los tags con `-` son prerelease y se ignoran. `GET /api/update` devuelve el estado y `POST /api/update/skip` (con la cabecera `X-Hotspotter`) omite una versión.
- Solo una comprobación **correcta** inicia la ventana de 6 horas; si falla, se reintenta en la siguiente carga de la app (decisión 93). Sin red o con un error de la API, falla en silencio (queda en el log).
- Solo con token: si GitHub responde 401 o 403 (token caducado o revocado), la barra de estado muestra una línea de aviso (`authError`, decisión 94) en lugar de la nota de versión nueva.

## Log

El lanzador escribe en `<carpeta de datos>\hotspotter.log` (decisión 98): una línea al arrancar (versión y puerto), los errores del servidor y los fallos de la comprobación de actualizaciones. Solo estado y mensaje, nunca el token. Al arrancar, si el archivo pasa de 1 MB se renombra a `hotspotter.log.1` (sustituyendo al anterior).

## Acceso

- Cualquiera descarga el zip desde la página de releases (`/releases/latest`), sin cuenta de GitHub. El botón del aviso abre la página del release; se descarga a mano y se **sobrescribe la carpeta antigua**. Por eso los datos del usuario no pueden vivir junto al `.exe`.
- El historial se reescribió al hacerlo público para que los commits usen la dirección noreply de GitHub del autor; los commits nuevos de este repo también la usan (`git config user.email` local).

## Token opcional

- Si el build recibe `HOTSPOTTER_READ_TOKEN` (secreto del repositorio), lo incrusta y la consulta va autenticada; sin él, va sin autenticar. Hoy el secreto no existe y el token se revocó.
- Solo haría falta si el repo volviera a ser privado: un **fine-grained personal access token** con acceso **solo a este repositorio** y permiso **solo de lectura de Contents y Metadata**, guardado como secreto `HOTSPOTTER_READ_TOKEN` y **nunca commiteado**. Cualquiera con el `.exe` podría extraerlo y leer el repo; si se filtrara, se revoca, se crea otro, se actualiza el secreto y se publica una versión (los `.exe` anteriores mostrarían `authError`).

## Proceso de release

`.github/workflows/release.yml` (decisión 96):

- **Empujar un tag `v*.*.*`** ejecuta `npm ci`, `npm test`, la comprobación de versiones (`check-version`), `npm run portable` (con `HOTSPOTTER_READ_TOKEN` si existe el secreto), las notas de release (sección del `CHANGELOG.md`) y `gh release create --verify-tag`. Un tag con `-` se publica como `--prerelease`.
- **`workflow_dispatch`** solo compila y sube el zip como artefacto: es el ensayo, y nunca publica.
- Permisos: `contents: read` en el workflow y `write` solo en el job; el checkout usa `persist-credentials: false`. Los e2e no se ejecutan en CI.

Versionado semver, con `CHANGELOG.md` en la raíz. Lo que se va fusionando se anota en su sección `## [Sin publicar]`.

### Publicar (decisión 99)

`npm run release <patch|minor|major|X.Y.Z>` (`scripts/release.mjs`) hace todo desde el PC: comprueba que estás en `main` sin cambios y al día con `origin`, que la etiqueta no existe y que `[Sin publicar]` tiene notas; enseña versión y notas y pide confirmación; pasa `npm test`; sube la versión en todos los `package.json` y en `package-lock.json`; convierte `[Sin publicar]` en `## [X.Y.Z] - fecha` (dejando una `[Sin publicar]` vacía); hace commit `chore: release vX.Y.Z`, crea la etiqueta anotada y sube rama y etiqueta con `git push --atomic`. El push de la etiqueta dispara la Action. Si se pasa la versión actual (`npm run release 0.1.0`) y su etiqueta no existe, no cambia versiones ni CHANGELOG: usa la sección `## [X.Y.Z]` que ya hay, etiqueta y sube (primer release o etiqueta que no llegó a subirse). `--sin-tests` se salta `npm test` y `--si` la confirmación (con npm van detrás de `--`). El uso resumido está en el [README](../README.md#publicar-una-versión).

### Ensayo sin publicar

Pestaña Actions → «Release» → Run workflow: compila y sube el zip como artefacto («Artifacts», un zip que contiene el zip portable) sin publicar nada. Validado por el usuario el 2026-11-17.
