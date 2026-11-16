# 02 · Arquitectura

Las decisiones de este documento son del constructor (Claude) salvo que se indique otra cosa. El usuario fijó: arquitectura web en localhost, release portable con `.exe` y la IA integrada sin ventanas externas.

## Piezas

```
┌───────────────────────────── navegador (Chrome/Edge) ─────────────────────────────┐
│  UI React + shadcn/ui     Vista 3D (three.js)     Motor de generación (WebGPU/WGSL) │
│        │                         ▲                         ▲                       │
│        └──── documento de proyecto (grafo de nodos) ───────┘                       │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ HTTP + WebSocket (localhost)
┌──────────────────────────────────────▼────────────────────────────────────────────┐
│  Servidor local (Node, empaquetado en hotspotter.exe)                              │
│  · sirve la app · lee/escribe proyectos y exporta a disco · comprueba updates      │
│  · descarga, arranca y supervisa el sidecar de IA                                   │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ HTTP local (solo si la IA está instalada)
                         ┌─────────────▼──────────────┐
                         │ Sidecar de IA (Python)      │
                         │ difusión + estimación PBR   │
                         └────────────────────────────┘
```

- **Frontend**: TypeScript, React, Vite, Tailwind y shadcn/ui (Radix). Solo modo oscuro. El editor de nodos usa React Flow (xyflow).
- **Motor de generación**: compute shaders WGSL sobre WebGPU, en el navegador. La GPU del usuario hace todo el trabajo pesado. WebGPU exige Chrome o Edge recientes; si no está disponible, la app lo dice al arrancar (sin fallback a CPU en v1).
- **Vista 3D**: three.js con WebGL. Lee el atlas de preview a la CPU una vez por composición (un mapa tras otro, a la resolución del preview) y lo sube como texturas WebGL; no comparte las texturas de WebGPU (decisión 80).
- **Servidor local**: Node 22 + TypeScript (Fastify o similar). El navegador no puede escribir en carpetas arbitrarias, así que las exportaciones, los proyectos y las librerías de materiales pasan por el servidor.
- **Sidecar de IA**: proceso Python independiente que se instala bajo demanda. Ver [07-ai.md](07-ai.md).

## Modelo de documento

- Un proyecto (`.hsp`) es un **grafo de nodos** serializado como JSON, más los recursos importados (texturas). Se guarda como zip.
- La **pila de capas** de la vista principal es una proyección lineal de ese grafo. Toda operación de la pila corresponde a nodos. Si el grafo tiene ramas que no caben en una pila lineal, la pila muestra esa parte como un bloque "Grafo personalizado" que se abre en la vista de nodos.
- Toda generación es determinista a partir de (grafo, recursos, seed). Mismo proyecto, mismo resultado, en cualquier máquina con WebGPU. Puede haber diferencias de redondeo de GPU, que deben quedar por debajo de 1/255.

## Evaluación

- **Preview**: se evalúa el grafo a resolución reducida (512–2048 px) al cambiar cualquier parámetro, con recálculo incremental de los nodos afectados.
- **Render final**: a la resolución de salida (hasta 8192 px), por teselas si hace falta para no agotar VRAM. Con desgaste, el compose a 8192 llega a ≈4.3 GiB de VRAM (decisión 46). Incluye las pasadas de calidad que el preview omite (supermuestreo del daño, filtrado de microdetalle, comprobaciones completas). Muestra progreso y se puede cancelar.
- El detalle se define en **unidades del mundo** (cm, mm), no en píxeles, para que el preview y el render final muestren lo mismo a distinta resolución. Excepción: el estilo pixel art, que trabaja en la rejilla de píxeles del material (ver [04-wear.md](04-wear.md)).

## Estructura del repositorio (propuesta)

```
apps/web        frontend (UI, vista 3D, motor WebGPU)
apps/server     servidor local + empaquetado del .exe
packages/core   tipos del documento, grafo, layouts, exportadores (compartido)
packages/engine nodos y shaders WGSL
sidecar/ai      servicio Python de IA
docs/           esta documentación
```

Monorepo con npm workspaces (npm 11 ya viene con Node 22; no hace falta instalar pnpm). Tests: Vitest para la lógica (layouts, matching, exportadores, serialización). Para el motor, tests de imagen "golden" que comparan contra referencias con tolerancia.
