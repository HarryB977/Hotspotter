# 08 · Distribución y actualizaciones

Decidido con el usuario:

- El código vive en un **repositorio privado de GitHub**.
- Los compañeros descargan un **release portable**: una carpeta (o zip) con `hotspotter.exe`. Sin instalador.
- La app **avisa** cuando hay una versión nueva en el repositorio.
- Para consultar los releases de un repo privado se **incrusta en el `.exe` un token de solo lectura** (opción elegida por el usuario frente a token por usuario o repo público de binarios).

## Portable

- `hotspotter.exe` arranca el servidor local en un puerto libre de localhost y abre la app en el navegador por defecto si es Chrome o Edge; si no, abre uno de los dos si está instalado y, si no hay ninguno, explica qué hace falta. Mientras la app está abierta queda un icono en la bandeja del sistema con "Abrir" y "Salir".
- Empaquetado: Node Single Executable Application (o una herramienta equivalente) más una carpeta con los assets del frontend. El constructor elige la herramienta concreta.
- Los datos del usuario (librería de materiales, ajustes, sidecar y modelos de IA) se guardan en una carpeta de datos (por defecto `%LOCALAPPDATA%\Hotspotter`), no junto al `.exe`, para que sustituir la carpeta del portable al actualizar no borre nada.
- Solo Windows en v1.

## Comprobación de actualizaciones

- Al arrancar (y como mucho una vez cada X horas) el **servidor**, no el navegador, consulta la API de releases de GitHub del repo con el token incrustado.
- Si la versión publicada (semver en el tag) es mayor que la local, la UI muestra un aviso discreto con las notas del release y un botón que abre la página de descarga. El usuario puede posponerlo u omitir esa versión.
- No se descarga ni se reemplaza nada automáticamente en v1.
- Sin red o con un error de la API, falla en silencio (queda en el log).

## Acceso y futuro repo público

- El usuario añadirá a sus compañeros como colaboradores del repositorio, así que el botón del aviso abre la página del release en GitHub y ellos descargan el zip a mano y **sobrescriben la carpeta antigua**. Por eso los datos del usuario no pueden vivir junto al `.exe`.
- Es probable que el repo se haga público algún día. El token tiene que ser **opcional**: si no se inyecta en el build, la consulta a la API se hace sin autenticar, que es lo que funciona con un repo público. Pasar a público solo requiere dejar de inyectar el token.

## Token incrustado: condiciones

- Debe ser un **fine-grained personal access token** con acceso **solo a este repositorio** y permiso **solo de lectura de contents/metadata** (lo mínimo que requiera la API de releases).
- Se inyecta en tiempo de build (variable de entorno del pipeline de release) y **nunca se commitea**.
- Riesgo asumido por el usuario: cualquiera con el `.exe` puede extraer el token y leer el repo. Si se filtra, se revoca, se genera otro y se publica un release nuevo.

## Proceso de release

Un script (o GitHub Action) compila, empaqueta, inyecta el token, genera el zip y crea el release con las notas sacadas del changelog. Versionado semver, con `CHANGELOG.md` en la raíz.
