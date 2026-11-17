# 08 · Distribución y actualizaciones

Decidido con el usuario:

- El código vive en un **repositorio privado de GitHub**.
- Los compañeros descargan un **release portable**: una carpeta (o zip) con `hotspotter.exe`. Sin instalador.
- La app **avisa** cuando hay una versión nueva en el repositorio.
- Para consultar los releases de un repo privado se **incrusta en el `.exe` un token de solo lectura** (opción elegida por el usuario frente a token por usuario o repo público de binarios).

## Portable

- `hotspotter.exe` abre una **ventana de consola** (sin icono en la bandeja; decisión 90) y arranca el servidor local en el puerto **7420**, o en uno libre si está ocupado (decisión 91). Abre la app en Chrome o Edge: el navegador por defecto si es uno de los dos, y si no el que esté instalado; si no hay ninguno, lo explica en la consola. Cerrar la ventana cierra Hotspotter. `HOTSPOTTER_NO_BROWSER=1` no abre el navegador.
- **Segunda copia** (decisión 92): el `.exe` consulta `/api/health` de la copia que ya está en marcha (`instance.json` en la carpeta de datos). Si es de la misma versión, abre esa en el navegador; si es de otra, avisa en la consola, espera Intro y sale.
- Empaquetado (decisión 95): `npm run portable` (`scripts/build-portable.mjs`) genera con esbuild un bundle CJS del lanzador y lo convierte en una Node 22 Single Executable Application con postject. Sale `dist/portable/Hotspotter/hotspotter.exe` (unos 83 MB) y, junto a él, la carpeta `web/` con el frontend; el zip pesa unos 32 MB. El `.exe` no está firmado: SmartScreen avisa la primera vez.
- Los datos del usuario (librería de materiales, ajustes, sidecar y modelos de IA) se guardan en una carpeta de datos (por defecto `%LOCALAPPDATA%\Hotspotter`, o `HOTSPOTTER_DATA_DIR` si está definida; hoy contiene `updates.json`, `instance.json` y `hotspotter.log`), no junto al `.exe`, para que sustituir la carpeta del portable al actualizar no borre nada.
- Solo Windows en v1.

## Comprobación de actualizaciones

- Al cargar la app (y como mucho una vez cada 6 horas, decisión 93) el **servidor**, no el navegador, consulta la API de releases de GitHub del repo con el token incrustado.
- Si la versión publicada (semver en el tag) es mayor que la local, la UI muestra un aviso discreto con las notas del release y un botón que abre la página de descarga. El usuario puede posponerlo u omitir esa versión.
- No se descarga ni se reemplaza nada automáticamente en v1.
- Solo cuentan las versiones estables (`vX.Y.Z`); los tags con `-` son prerelease y se ignoran. `GET /api/update` devuelve el estado y `POST /api/update/skip` (con la cabecera `X-Hotspotter`) omite una versión.
- Solo una comprobación **correcta** inicia la ventana de 6 horas; si falla, se reintenta en la siguiente carga de la app (decisión 93). Sin red o con un error de la API, falla en silencio (queda en el log).
- Si GitHub responde 401 o 403 (token caducado o revocado), la barra de estado muestra una línea de aviso (`authError`, decisión 94) en lugar de la nota de versión nueva.

## Log

El lanzador escribe en `<carpeta de datos>\hotspotter.log` (decisión 98): una línea al arrancar (versión y puerto), los errores del servidor y los fallos de la comprobación de actualizaciones. Solo estado y mensaje, nunca el token. Al arrancar, si el archivo pasa de 1 MB se renombra a `hotspotter.log.1` (sustituyendo al anterior).

## Acceso y futuro repo público

- El usuario añadirá a sus compañeros como colaboradores del repositorio, así que el botón del aviso abre la página del release en GitHub y ellos descargan el zip a mano y **sobrescriben la carpeta antigua**. Por eso los datos del usuario no pueden vivir junto al `.exe`.
- Es probable que el repo se haga público algún día. El token tiene que ser **opcional**: si no se inyecta en el build, la consulta a la API se hace sin autenticar, que es lo que funciona con un repo público. Pasar a público solo requiere dejar de inyectar el token.

## Token incrustado: condiciones

- Debe ser un **fine-grained personal access token** con acceso **solo a este repositorio** y permiso **solo de lectura de contents/metadata** (lo mínimo que requiera la API de releases).
- Se inyecta en tiempo de build (variable de entorno del pipeline de release) y **nunca se commitea**.
- Riesgo asumido por el usuario: cualquiera con el `.exe` puede extraer el token y leer el repo. Si se filtra, se revoca, se genera otro y se publica un release nuevo.

## Proceso de release

`.github/workflows/release.yml` (decisión 96):

- **Empujar un tag `v*.*.*`** ejecuta `npm ci`, `npm test`, la comprobación de versiones (`check-version`), `npm run portable` con `HOTSPOTTER_READ_TOKEN` inyectado, las notas de release (sección del `CHANGELOG.md`) y `gh release create --verify-tag`. Un tag con `-` se publica como `--prerelease`.
- **`workflow_dispatch`** solo compila y sube el zip como artefacto: es el ensayo, y nunca publica.
- Permisos: `contents: read` en el workflow y `write` solo en el job; el checkout usa `persist-credentials: false`. Los e2e no se ejecutan en CI.

El procedimiento paso a paso está en el [README](../README.md#publicar-una-versión). Versionado semver, con `CHANGELOG.md` en la raíz.
