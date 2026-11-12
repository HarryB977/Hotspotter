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
```
