# Hotspotter

Herramienta que convierte un material PBR tileable en un atlas de hotspots (WebGPU) y lo exporta para Unity (URP/HDRP) y Anvil.

## Requisitos

- Node 22
- Chrome o Edge actualizados (con WebGPU)

## Uso

```
npm install
npm run dev
```

`npm run dev` arranca el servidor local (puerto 7420) y la web (http://localhost:5173).

## Proyectos

El menú Archivo guarda y abre proyectos `.hsp` (un zip con el diseño, el material, la máscara y el segundo material; ver [docs/06-export.md](docs/06-export.md#proyecto-hsp)). La vista 3D prueba el atlas sobre formas simples.

## Tests

```
npm test       # core y servidor
npm run e2e    # Playwright (arranca servidor y web si no están en marcha)
npm run bench  # banco visual sobre samples/pbr (necesita samples/, que no está en git)
```

`npm run bench` exporta cada set de `samples/pbr/` a 2048 px en `samples/_bench/<fecha-hora>/` y abre un `index.html` con miniaturas y las comprobaciones de cada set (ver [docs/11-test-bench.md](docs/11-test-bench.md)).

## Publicar una versión

Los releases los crea GitHub Actions (`.github/workflows/release.yml`) al empujar un tag `vX.Y.Z`. Detalles en [docs/08-distribution.md](docs/08-distribution.md).

1. **Crea el token de lectura** (una sola vez): GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token. Repositorio: solo `HarryB977/Hotspotter`. Permisos: Contents de solo lectura y Metadata de solo lectura. Elige tú la caducidad.
2. **Guárdalo como secreto** del repositorio: Settings → Secrets and variables → Actions → New repository secret, con el nombre `HOTSPOTTER_READ_TOKEN`.
3. **Antes de la primera versión, haz el ensayo**: pestaña Actions → "Release" → Run workflow. Compila y sube el zip como artefacto sin publicar nada; descárgalo y pruébalo.
4. **Publica**: sube la versión en todos los `package.json`, añade una sección `## [X.Y.Z]` a `CHANGELOG.md` (sus notas serán las del release), haz commit y:

   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   Un tag con guion (`v0.2.0-beta.1`) se publica como prerelease y la app no lo ofrece como actualización.
5. **Rotar el token**: revócalo en GitHub, crea uno nuevo, actualiza el secreto `HOTSPOTTER_READ_TOKEN` y publica una versión nueva. Los `.exe` ya repartidos dejan de ver actualizaciones y muestran en la barra de estado la línea de aviso de acceso (`authError`).

### Para tus compañeros

- Descarga el zip del release y descomprímelo; ejecuta `hotspotter.exe` de la carpeta.
- SmartScreen avisará porque el `.exe` no está firmado: Más información → Ejecutar de todas formas.
- Para actualizar, cierra Hotspotter (la ventana de consola) y sobrescribe la carpeta con la nueva.
- Tus datos están en `%LOCALAPPDATA%\Hotspotter`, fuera de la carpeta del programa, así que sobrescribirla no los borra. Ahí también está `hotspotter.log`.

