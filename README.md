# Hotspotter

Convierte un material PBR tileable en un atlas de hotspots (rectángulos con bisel y desgaste) y lo exporta para Unity (URP/HDRP) y Anvil.

## Descargar y usar

1. Descarga el zip de la **[última versión](https://github.com/HarryB977/Hotspotter/releases/latest)** (en «Assets», `Hotspotter-X.Y.Z-win64.zip`).
2. Descomprímelo entero donde quieras y abre `hotspotter.exe` desde la carpeta descomprimida, nunca desde dentro del zip.
3. La primera vez Windows mostrará SmartScreen porque el `.exe` no está firmado: **Más información → Ejecutar de todas formas**.
4. Se abre una ventana de consola y la app en Chrome o Edge. **Cerrar la consola cierra Hotspotter.**

Necesitas Windows 10 u 11 y Chrome o Edge actualizados (la app usa WebGPU). No hace falta instalar nada más.

### Actualizar

Cuando haya una versión nueva, la app lo avisa en la barra de estado. Para actualizar, cierra Hotspotter (la ventana de consola), descarga el zip nuevo y sobrescribe la carpeta.

Tus datos están en `%LOCALAPPDATA%\Hotspotter`, fuera de la carpeta del programa, así que sobrescribirla no los borra. Ahí también está `hotspotter.log`, útil si algo falla.

### Proyectos

El menú Archivo guarda y abre proyectos `.hsp` (un zip con el diseño, el material, la máscara y el segundo material; ver [docs/06-export.md](docs/06-export.md#proyecto-hsp)). La vista 3D prueba el atlas sobre formas simples.

---

## Desarrollo

Requisitos: Node 22 y Chrome o Edge con WebGPU. La documentación por temas está en [docs/](docs/README.md).

```
npm install
npm run dev
```

`npm run dev` arranca el servidor local (puerto 7420) y la web (http://localhost:5173).

### Tests

```
npm test       # tipos, core, servidor, web y scripts de release
npm run e2e    # Playwright (arranca servidor y web si no están en marcha)
npm run bench  # banco visual sobre samples/pbr (necesita samples/, que no está en git)
```

`npm run bench` exporta cada set de `samples/pbr/` a 2048 px en `samples/_bench/<fecha-hora>/` y abre un `index.html` con miniaturas y las comprobaciones de cada set (ver [docs/11-test-bench.md](docs/11-test-bench.md)).

### Portable local

`npm run portable` genera `dist/portable/Hotspotter/hotspotter.exe` y el zip, sin publicar nada.

### Publicar una versión

1. Comprueba que la sección `## [Sin publicar]` de [CHANGELOG.md](CHANGELOG.md) tiene las notas de lo que cambia; serán las notas del release.
2. Desde `main`, sin cambios pendientes:

   ```
   npm run release minor
   ```

   `patch` para arreglos (0.1.0 → 0.1.1), `minor` para novedades (0.1.0 → 0.2.0), `major` para 1.0.0, o una versión exacta (`npm run release 0.2.0-beta.1`; con guion es prerelease y la app no la ofrece).

El comando enseña la versión y las notas y pide confirmación. Después pasa `npm test`, sube la versión en todos los `package.json`, fecha las notas del CHANGELOG, hace el commit, crea la etiqueta y sube ambas cosas. GitHub Actions compila el `.exe` y publica el release en unos minutos. Si algo no cuadra (otra rama, cambios sin commitear, `main` desfasado, notas vacías, etiqueta repetida), se para sin tocar nada.

Opciones (van detrás de `--`): `npm run release -- minor --sin-tests` se salta `npm test` (la Action lo pasa igualmente) y `--si` no pide confirmación.

Detalles del proceso, el token de lectura y el ensayo sin publicar: [docs/08-distribution.md](docs/08-distribution.md#proceso-de-release).
