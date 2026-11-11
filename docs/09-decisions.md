# 09 · Registro de decisiones

Quién decidió qué, para no reabrir decisiones cerradas. "Usuario" = el autor del proyecto; "Constructor" = decisión de Claude, revisable.

| # | Decisión | Quién | Fecha |
|---|---|---|---|
| 1 | Arquitectura web ejecutada en localhost | Usuario | 2026-11-11 |
| 2 | La entrada por defecto es un set PBR tileable del usuario; la IA es opcional | Usuario | 2026-11-11 |
| 3 | Las proporciones del material (hiladas, tablones, bandas) son una regla dura | Usuario | 2026-11-11 |
| 4 | El desgaste nace de la estructura del material y se esculpe sobre un campo de altura único | Constructor, aprobado por el usuario | 2026-11-11 |
| 5 | Comprobaciones automáticas; calidad antes que velocidad (render final en GPU) | Usuario | 2026-11-11 |
| 6 | Máscara B/N opcional para guiar el daño | Usuario | 2026-11-11 |
| 7 | Tres modos de layout: presets, manual y automático | Usuario | 2026-11-11 |
| 8 | La herramienta no transforma el estilo del material; estilo de daño elegible: realista / estilizado / pixel art | Usuario | 2026-11-11 |
| 9 | IA de imagen (generar tileable desde cero + inpainting de bordes), descargada y gestionada desde la app, sin ventanas externas | Usuario | 2026-11-11 |
| 10 | UI: distribución A (pila de capas + inspector) como principal, grafo de nodos como vista avanzada | Usuario | 2026-11-11 |
| 11 | Internamente el documento es un grafo; la pila es una proyección | Constructor | 2026-11-11 |
| 12 | Release portable con `.exe` desde un repo privado de GitHub; aviso de actualizaciones | Usuario | 2026-11-11 |
| 13 | Token de solo lectura incrustado en el `.exe` para consultar releases | Usuario | 2026-11-11 |
| 14 | Generación con WebGPU/WGSL en el navegador; servidor Node; sidecar Python para IA | Constructor | 2026-11-11 |
| 15 | React + TypeScript + Vite + Tailwind + shadcn/ui; three.js; React Flow | Constructor | 2026-11-11 |
| 16 | `.hotspot.json` propio como fuente de verdad; `.rect`, tabla Anvil y JSON para ProBuilder como exportaciones extra | Constructor | 2026-11-11 |
| 17 | No modificar la extensión de ProBuilder existente; solo sirve de referencia | Usuario | 2026-11-11 |
| 18 | Solo Windows en v1; Chrome/Edge requeridos (WebGPU) | Constructor | 2026-11-11 |
| 19 | Funcionalidades repartidas en versiones usables (v0.1–v0.4, ver 10-roadmap.md) | Usuario (contenido propuesto por el constructor) | 2026-11-11 |
| 20 | `samples/` es el banco de pruebas y la referencia de calidad | Usuario | 2026-11-11 |
| 21 | Se descartan los modelos de IA con licencia no comercial | Usuario | 2026-11-11 |
| 22 | Compañeros como colaboradores; descarga manual sobrescribiendo la carpeta; token opcional para un futuro repo público | Usuario | 2026-11-11 |
| 23 | La RTX 3060 del autor es la GPU de referencia | Usuario | 2026-11-11 |
| 24 | Unity + Anvil CSG es el destino prioritario de exportación | Constructor | 2026-11-11 |
| 25 | Revelado en zona y variantes sobre el mismo layout (vistos en samples/examples) | Constructor | 2026-11-11 |
| 26 | `samples/` no se commitea (material de terceros, posible repo público) | Constructor | 2026-11-11 |
