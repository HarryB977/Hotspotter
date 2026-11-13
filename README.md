# Hotspotter

Herramienta local para profesionales que convierte un material PBR tileable en un atlas de hotspots (WebGPU) y lo exporta para Unity (URP/HDRP) y Anvil.

## Requisitos

- Node 22
- Chrome o Edge actualizados (con WebGPU)

## Uso

```
npm install
npm run dev
```

`npm run dev` arranca el servidor local (puerto 7420) y la web (http://localhost:5173).

## Tests

```
npm test       # core y servidor
npm run e2e    # Playwright (arranca servidor y web si no están en marcha)
npm run bench  # banco visual sobre samples/pbr (necesita samples/, que no está en git)
```

`npm run bench` exporta cada set de `samples/pbr/` a 2048 px en `samples/_bench/<fecha-hora>/` y abre un `index.html` con miniaturas y las comprobaciones de cada set (ver [docs/11-test-bench.md](docs/11-test-bench.md)).
