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
| 27 | La normal interna sigue el signo físico de la pendiente (Sobel): donde la altura baja hacia +X, la normal GL apunta a +X | Constructor | 2026-11-11 |
| 28 | El layout automático cubre la mayor región múltiplo del periodo anclada abajo a la izquierda; las franjas sobrantes (< 1 periodo) quedan vacías como ranura | Constructor | 2026-11-11 |
| 29 | Molduras con periodo X que no divide el ancho del atlas: se emiten como bandas (`group: band`) sin `tileU`, nunca estiradas ni cortadas | Constructor | 2026-11-11 |
| 30 | Origen del material (y hacia arriba) = texel inferior izquierdo del albedo; los mapas se muestrean con repetición | Constructor | 2026-11-11 |
| 31 | En v0.1-A el BaseColor se trata como bytes de 8 bits sin decodificar sRGB (filtrado en espacio gamma); el filtrado lineal correcto se aplaza | Constructor | 2026-11-11 |
| 32 | El ancho de ranura es el fondo plano (`widthM`); el bisel ocupa `widthM/2` extra a cada lado, dentro del rectángulo. La UI lo llama "Fondo de ranura"; un ancho de bisel propio se aplaza a v0.1-B | Constructor | 2026-11-11 |
| 33 | El servidor solo acepta Host de loopback y Origin de la app (localhost/127.0.0.1 en 5173 y 7420); escribir archivos exige la cabecera `X-Hotspotter: 1`; rechaza rutas UNC, `..`, `:` y nombres reservados de Windows; Vite sin CORS | Constructor | 2026-11-11 |
| 34 | Si un ajuste del material cambia durante una importación, gana la importación | Constructor | 2026-11-11 |
| 35 | Los PNG se codifican en TypeScript puro (RGBA 8 bits, sin premultiplicar) en vez de con canvas, para no corromper RGB donde A < 255 | Constructor | 2026-11-11 |
| 36 | Export con poca memoria: mapas leídos y subidos de uno en uno; aviso de ≈2 GB de RAM al elegir 8192 | Constructor | 2026-11-11 |
| 37 | El export resuelve el layout a su propia resolución: los px de `hotspot.json` y del CSV de Anvil coinciden con los PNG (±1 px respecto a la preview) | Constructor | 2026-11-11 |
| 38 | Si el material trae normal map, Sobel solo actúa sobre la altura de la ranura (altura total menos la del material) y el relieve del material lo aporta su normal; sin normal map, Sobel sobre la altura total. El Height exportado es siempre la altura total | Constructor | 2026-11-11 |
| 39 | Si los archivos no comparten prefijo, el material toma el nombre de la carpeta, y si no, "material"; el nombre es editable y se sanea para usarlo en archivos | Constructor | 2026-11-11 |
| 40 | R16 superada: el bisel es un parámetro propio (`bevelM`, 3 mm por defecto). `widthM` es el fondo plano de la ranura, centrado en el borde compartido, y el bisel ocupa `bevelM` dentro de cada rectángulo. `hotspot.json` escribe `bevelM`; si falta al leer, se usa `widthM / 2` | Constructor | 2026-11-12 |
| 41 | Fase del material = centro de la banda de junta, en metros desde abajo y desde la izquierda del material: un rectángulo que arranca en junta empieza en mitad de la llaga | Constructor | 2026-11-12 |
| 42 | Las juntas se detectan sobre el relieve de junta (cierre morfológico menos altura, normalizado al rango p1–p99), no sobre la altura en bruto. Otsu sobre el relieve decide si hay juntas (separabilidad ≥ 0.70 y profundidad ≥ 0.1) y siembra la junta, que crece por histéresis hasta `t_seg = 1 − (1 − t_otsu) · 0.38`. `threshold` es ese `t_seg` (el del usuario, si lo da) y `suggestedThreshold` lo conserva aunque se descarten las juntas. `jointDistM` nunca es infinito: se limita a `max(tileSizeM)`, que es el valor en todo el mapa si no hay juntas | Constructor | 2026-11-12 |
| 43 | Máscara B/N del desgaste: el gris medio es neutro, el negro anula el daño y el blanco lo duplica (`mix(1, 2·m, strength)`, con el potencial limitado a 1). Solo se aplica si hay textura y `mask.enabled`. Sin eje de veta, la anisotropía de la familia estira las celdas a lo largo de X del material. El desplazamiento de ruido por rectángulo usa el índice del rectángulo, así que reordenar los rectángulos cambia su desgaste | Constructor | 2026-11-12 |
| 44 | Altura del desgaste (Task 9): `border` por jump flooding desde los puntos medios del contorno, limitado a ±4·`bandM`, con semillas r32uint (x \| y << 16 en medios píxeles) en lugar de rg32sint para ahorrar la mitad de memoria. La rugosidad micro y las grietas de la banda se atenúan hasta 0 en el contorno y en el final de la banda (sin escalones de un píxel). `wearMask = smoothstep(0, bandM, −border)`. La altura macro incluye el desgaste (amplía la 38). Las familias sin pérdida de capa (`dent`) hunden la superficie con su profundidad suave. Sin desgaste, el Sobel sigue leyendo la altura de la ranura en f16 (`matNormal.a`) para que la salida no cambie ni un byte; con desgaste lee `macroHeight` (r32float) | Constructor | 2026-11-12 |
| 45 | El fondo de ranura nunca se desgasta (R31): marca `lossR = −1` en `loss` (todo lector la trata como 0), sin semillas de contorno, sin cambio de altura y con `wearMask` a 0. El contorno solo se forma dentro de un mismo rectángulo. Ninguna rotura baja del fondo de ranura y el límite de profundidad es `hMat − depthM − 0.5·microM` (R32) | Coordinador | 2026-11-12 |
| 46 | Memoria (amplía la 36): con desgaste a 8192 el pico de VRAM es de ≈4.3 GiB (68 B/px: los 14 mapas del compose más las dos texturas temporales de semillas JFA, que se liberan nada más componer). Sin desgaste son ≈3.0 GiB (48 B/px) | Constructor | 2026-11-12 |
| 47 | Pasada de color (Task 10): corre con y sin desgaste sobre la altura final y escribe color, rugosidad, metálico y AO sin texturas intermedias (vuelve a muestrear el material). El AO de altura (`k = 0.7`, radios 5/20/60 mm, 8 taps bilineales) sustituye al `1 − 0.5·prof` también sin desgaste. `hueShift` va en grados. Sin `dirt` no hay suciedad. La rugosidad de cavidad suma `0.1·cavity·(1 − AO_altura)`. El tono de canto sube el valor hacia 1 y no actúa con `widthM` 0. La escorrentía de las pérdidas se calcula recorriendo tramos de columna de arriba abajo; baja en el eje −Y del atlas | Constructor | 2026-11-12 |
