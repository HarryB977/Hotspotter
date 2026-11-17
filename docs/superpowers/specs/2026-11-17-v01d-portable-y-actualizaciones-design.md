# v0.1-D: `.exe` portable y aviso de actualizaciones

Diseño acordado con el usuario el 2026-11-17. Concreta [docs/08-distribution.md](../../08-distribution.md), que ya recoge lo decidido antes (repositorio privado, release portable sin instalador, token de solo lectura incrustado y opcional, datos fuera de la carpeta del `.exe`). Este documento solo añade lo que faltaba y lo que cambia.

## Por qué

El usuario quiere que sus compañeros usen Hotspotter sin clonar el repo ni instalar Node. Que descarguen un zip, lo abran y trabajen, y que la app les avise cuando haya una versión nueva. Con esto se cierra la v0.1 (docs/10).

## Objetivos

### Publicar una versión

- **La publica GitHub, no el PC del usuario** (decidido con el usuario). Al subir una etiqueta semver (`v0.1.0`), una GitHub Action en un runner de Windows:
  1. instala dependencias y pasa `npm test` y `npm run build`;
  2. empaqueta servidor y frontend en la carpeta portable con `hotspotter.exe`;
  3. inyecta el token de solo lectura desde un secreto del repositorio;
  4. crea el zip;
  5. publica el release con ese zip y las notas de esa versión sacadas de `CHANGELOG.md`.
- **El token:**
  - Nunca está en el código ni en el log de la Action.
  - Si el secreto no existe, el build sale igual y la consulta de versiones va sin autenticar, que es lo que funciona con un repo público.
- **Versión:**
  - La etiqueta manda: si no coincide con la versión de los `package.json`, la Action falla con un mensaje claro.
  - La primera release es la `v0.1.0`, con un `CHANGELOG.md` en la raíz que resume la v0.1 en español (decisión del constructor).

### Usar el portable

- El compañero descomprime el zip donde quiera y abre `hotspotter.exe`.
- **Ventana de consola** (decidido con el usuario, en lugar del icono de la bandeja del sistema de docs/08). Es pequeña y en español:
  - dice que Hotspotter está abierto en el navegador, con la dirección;
  - avisa de que cerrar la ventana cierra la app.
- **Navegador:** el `.exe` arranca el servidor local y abre la app en Chrome o Edge (WebGPU). Si el navegador por defecto no es uno de los dos, abre el que esté instalado. Si no hay ninguno, la consola explica qué instalar y deja la dirección para copiarla.
- **Puerto estable** (decisión del constructor):
  - Intenta siempre el 7420 y solo cambia a otro libre si está ocupado.
  - Así no se pierden los ajustes de la interfaz, que el navegador guarda por dirección (`hs.view3d`, `hs.viewport`).
  - Si el puerto cambia, la consola lo dice.
- **Seguridad:** las comprobaciones de Host y Origin del servidor (solo loopback) siguen funcionando con el puerto real que se use, no solo con el 7420. El servidor sigue escuchando solo en `127.0.0.1`.
- **Segunda copia:** si ya hay un Hotspotter abierto, abrir el `.exe` otra vez abre esa app en el navegador en vez de arrancar una segunda copia.
- **Datos del usuario:** van en `%LOCALAPPDATA%\Hotspotter`, nunca junto al `.exe`. Al sobrescribir la carpeta para actualizar no se pierde nada. En la v0.1-D esa carpeta guarda los ajustes del aviso de actualizaciones (versión omitida, última consulta) y el log.

### Aviso de actualizaciones

- **Quién consulta:** al arrancar, y como mucho una vez cada 6 horas, el servidor (no el navegador) consulta la API de releases de GitHub, con el token si lo hay.
- **Qué muestra:** si la última versión publicada es mayor que la local (semver), la app muestra un aviso discreto con:
  - la versión;
  - sus notas;
  - un botón «Descargar», que abre la página del release;
  - los botones «Más tarde» y «Omitir esta versión».
- **Qué no hace:** no descarga ni reemplaza nada.
- **Sin red o con error:** no dice nada y lo deja en el log.
- **Token rechazado** (decidido con el usuario): si GitHub responde 401 o 403 (token caducado o revocado), la app muestra una línea discreta: «No se pueden comprobar actualizaciones; pide la versión nueva». Distinto de «sin red», que sigue sin decir nada. docs/08 explica cómo renovar el token y que hay que publicar una versión nueva al hacerlo.
- **Solo versiones estables** (decisión del constructor): las etiquetas de prerelease (`v0.2.0-beta.1`) se publican marcadas como prerelease en GitHub y la app nunca las ofrece. La consulta usa la última release estable.
- **En desarrollo** (`npm run dev`, sin `.exe`): la consulta no se hace.

### Actualizar con la app abierta

- Windows bloquea un `.exe` en marcha, así que no se puede sobrescribir la carpeta con Hotspotter abierto. Las notas de cada release y docs/08 dicen «cierra Hotspotter antes de sobrescribir la carpeta» (decisión del constructor).
- **Segunda copia de otra versión** (decisión del constructor): antes de abrir la copia que ya está en marcha, el `.exe` le pregunta su versión (`/api/health`). Si es distinta, la consola dice «Hay otra versión de Hotspotter abierta (x.y.z); ciérrala y vuelve a abrir esta» y no abre la vieja.
- **SmartScreen:** un `.exe` sin firmar descargado de internet hará saltar SmartScreen. Las notas de la release y docs/08 explican «Más información → Ejecutar de todas formas» (decisión del constructor; firmar sigue fuera de alcance).

## No objetivos

- Instalador, firma de código, actualización automática, macOS/Linux.
- Icono en la bandeja del sistema.
- Librería de materiales y sidecar de IA (llegan en versiones posteriores; solo se reserva la carpeta de datos).

## Anti-objetivos

- Que el token aparezca en el repositorio, en un log o en la respuesta de la API del servidor al navegador.
- Que actualizar (sobrescribir la carpeta) borre ajustes del usuario.
- Que el servidor deje de ser solo loopback o pierda las comprobaciones de Host/Origin.
- Que el `.exe` necesite tener Node instalado.

## Restricciones

- Node 22 (entorno del autor y del runner).
- Empaquetado: Node Single Executable Application u otra herramienta equivalente. Elige el constructor.
- El servidor importa `@hotspotter/core` (docs/10): el empaquetado debe incluirlo.
- El frontend se sirve ya compilado desde el servidor (`apps/server/src/app.ts`, `@fastify/static`).
- Textos en español; código y comentarios en inglés.
- Las decisiones nuevas van en `docs/09-decisions.md` a partir de la #90. docs/08 se actualiza (consola en vez de bandeja, puerto estable, CHANGELOG).

## Decidido con el usuario

- La release la compila y publica una GitHub Action al subir la etiqueta.
- Ventana de consola en lugar de icono en la bandeja.
- Si GitHub rechaza el token, la app lo avisa con una línea discreta.
- Lo de docs/08: portable sin instalador, token incrustado opcional y solo lectura, aviso que no descarga nada, datos en `%LOCALAPPDATA%\Hotspotter`.

## Decisiones del constructor (sin confirmar con el usuario)

- Puerto preferido 7420, con otro libre como reserva.
- Una segunda copia abre la primera en vez de arrancar otra.
- Consulta de versiones como mucho cada 6 horas.
- Primera release `v0.1.0` con `CHANGELOG.md` en español.
- La consulta no se hace en desarrollo.

## Lo que queda para el constructor

- La herramienta de empaquetado y cómo meter el frontend y `core` dentro (o junto) al `.exe`.
- Cómo detectar Chrome y Edge en Windows (registro, rutas conocidas).
- Cómo se ve el aviso en la UI (debe ser discreto, encajar en la barra o la barra de estado, y no tapar el trabajo).
- Cómo probar la Action sin publicar una release real (por ejemplo, una etiqueta de prueba en un fork o un modo de ensayo).
