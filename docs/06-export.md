# 06 · Exportación

## Mapas

Se exporta un PNG por mapa (8 o 16 bits; height también en EXR de 32 bits) con un prefijo común: `<nombre>_BaseColor`, `_Normal`, `_Height`, `_Roughness`, `_Metallic`, `_AO`, `_Opacity` (si existe), más dos auxiliares: `_RectID` (color por rectángulo) y `_WearMask` (daño 0–1, útil para shaders).

- El export compone con las mismas entradas que la vista previa (desgaste, suciedad, máscara B/N, segundo material y eje de veta), solo que a su resolución. Con la misma resolución y el mismo layout, los mapas salen idénticos byte a byte a los de la vista previa.
- `_WearMask` es el `wearMask` del compose en gris (R = G = B, A = 255). Sin desgaste (o con su interruptor apagado) sale negro, y `hotspot.json` no lleva el bloque `wear`.
- `_RectID` pinta cada rectángulo con el mismo color hash que la vista "IDs rect" (`rectIdRgb` en `packages/core`, `ID_FS` en la vista: 64 + (byte · 166 >> 8) por canal). La ranura vacía es gris oscuro (13).
- La resolución del diálogo de exportar es `resolutionPx` del nodo de salida: el panel de comprobaciones y el export leen el mismo valor.
- La escorrentía empieza en 0 y la suciedad apagada no tiene; solo con escorrentía activa, el aviso de giro (ver abajo) sale en cuanto se abre el diálogo. Al reabrirlo no queda el resumen ni el resultado de la exportación anterior.
- Antes de exportar, el diálogo pasa las seis comprobaciones de [04](04-wear.md) (composición de evaluación a 2048 px; el sangrado se calcula a la resolución de exportación) y muestra el resumen. Los avisos (o un fallo de las comprobaciones) no bloquean la exportación.

### Presets por destino

| Preset | Normal | Empaquetado |
|---|---|---|
| Blender / Maya | OpenGL | mapas sueltos |
| Unity URP | OpenGL | `_MetallicSmoothness` (R metal, A smoothness) + AO aparte |
| Unity HDRP | OpenGL | `_MaskMap` (R metal, G AO, B detail mask, A smoothness) |
| Unreal | DirectX | `_ORM` (R AO, G rough, B metal) |
| Source 2 | DirectX | mapas sueltos según convención de Source 2 |
| Pixel / Retro | (opcional) | mapas sueltos a la resolución de la rejilla, con aviso de usar filtrado point |
| Personalizado | elegible | empaquetado de canales libre, guardable como preset propio |

## Definición de rectángulos

Siempre se exporta `<nombre>.hotspot.json`, el formato propio y la fuente de verdad: versión, tamaño del atlas en px, ancho en metros, densidad y la lista de rectángulos con todos los campos de [03](03-material-and-layout.md) en píxeles (origen arriba a la izquierda) y en UV (0–1, origen abajo a la izquierda).

Campos de `hotspot.json` (versión 1):

| Campo | Contenido |
|---|---|
| `version`, `name` | 1 y el nombre del material |
| `atlas` | `widthPx`, `heightPx`, `worldWidthM`, `pxPerMetre` |
| `heightRangeM` | rango de altura en metros que mapea el `_Height` 0–255 |
| `maps` | nombres de los PNG escritos, `_WearMask` y `_RectID` incluidos |
| `wear` | `{ family, seed }` del desgaste con que se compuso; falta si se compuso sin desgaste |
| `checks` | `[{ id, status }]` de las comprobaciones al exportar (`ok`, `warn` o `error`); falta si no se pudieron hacer |
| `groove` | ancho, profundidad, bisel y perfil de la ranura |
| `rects` | `id`, `px`, `uv`, `allowRotation`, `allowMirrorX/Y`, `tileU/V`, `useOn`, `inset`, `group` |

**Escorrentía y volteos.** La escorrentía (`dirt.runoff > 0` con la suciedad encendida; 0 por defecto) pinta chorretones que caen hacia −Y del atlas. Girar o voltear en vertical un rectángulo en el motor los deja de lado o hacia arriba. Por eso, con escorrentía:

- `hotspot.json` escribe `allowMirrorY: false` en todos los rectángulos (el volteo horizontal se respeta).
- La tabla de Anvil escribe `Can mirror` = `no`, porque suponemos que Anvil tiene un único flag de volteo para los dos ejes y no puede limitarlo al horizontal. **Sin verificar:** no se ha comprobado en Anvil. La columna `Mirror X ok` lleva el `allowMirrorX` del rectángulo, por si el volteo horizontal se puede permitir a mano.
- `allowRotation` / `Can rotate` no cambian, pero el resumen del diálogo avisa de que girar esos rectángulos en el motor gira los chorretones.

Formatos adicionales opcionales:

- **Valve `.rect`** (Source 2 / Hammer): rectángulos en píxeles con su flag de rotación. El constructor debe verificar la sintaxis exacta con un archivo `.rect` real o con la documentación de Source 2, porque la página de la wiki que se revisó no la detalla.
- **Anvil CSG**: Anvil no tiene un formato importable; su layout se crea en el editor ("Detect Grid" a partir de las ranuras, o a mano). Por eso: (a) las ranuras por defecto están pensadas para que "Detect Grid" las encuentre, y (b) se exporta una tabla legible (`.anvil.txt`/CSV) con X, Y, Width, Height en px desde arriba a la izquierda, Can rotate, Can mirror, Repeats across/down, Use on y Sheet Width (m), para meterla a mano o con un script futuro.
- **HarryTools ProBuilder Extensions**: un `.json` que un pequeño importador del lado de Unity pueda convertir en `HotspotLayout` (World Width, patches con Allow Rotation, Allow Mirror X/Y, Allow Tiling, Inset). El importador de Unity queda fuera de este repo; no se toca la herramienta existente.
- **Blender**: el JSON propio. Un addon de Blender queda fuera del alcance de v1.

## Exportar a 8192

- La textura intermedia rgba16float de normales (`matNormal`) se limpia con una pasada de render. Si fuera solo de storage, Dawn la limpiaría con un buffer de staging de 512 MiB a 8192², por encima del `maxBufferSize` por defecto (256 MiB), y perdería el dispositivo. Ahora el buffer más grande es el de un mapa de 4 B/px (256 MiB a 8192²), y el export a 8192 funciona con el límite por defecto (46 s en una RTX 3060). El dispositivo se sigue pidiendo con el `maxBufferSize` del adaptador (2 GiB en una RTX 3060) como margen.
- Antes de exportar, el diálogo comprueba cada resolución contra los límites del dispositivo: el buffer de un mapa (ancho · 4 B, filas a 256 B, por alto) contra `maxBufferSize`, y el lado mayor contra `maxTextureDimension2D`. La resolución que no cabe sale desactivada; si ya estaba elegida, el diálogo dice por qué y propone una menor, y no deja exportar.
- El compose va en varios `queue.submit`, uno por grupo de pasadas. La pasada de color y cada paso del JFA van en bandas de unas 1024 filas, cada una en su propio submit, para que ningún trabajo de GPU dure lo bastante como para que Windows reinicie el driver (TDR). La salida no depende de las bandas: un test la compara byte a byte.
- Al elegir 8192, el diálogo avisa de que necesita unos 2 GB de RAM y, con desgaste, unos 4–5 GB de memoria de vídeo (decisión 46).
- Si se pierde la GPU, la app muestra el motivo y el mensaje del driver en lugar de quedarse esperando.
- Los pipelines se crean una vez por dispositivo dentro de un `pushErrorScope('validation')`, y cada entrada de la caché guarda su resultado. Cada compose espera solo el de los pipelines que usó: un error de WGSL sale como error de ese compose, no como mapas en blanco ni como error de otro compose que corra a la vez. El mensaje empieza por "Error interno de un shader (…)" y sigue con el detalle de WebGPU, en inglés.
- Prueba manual: `HS_PROBE_8K=1 npx playwright test e2e/probe8k.spec.ts` (en `apps/web`) exporta bricks wall 13 a 8192 y dice cómo acaba.

## Carpeta de salida

La elige el usuario y se recuerda por proyecto. Al volver a exportar se sobrescriben los mismos nombres de archivo, para que los motores mantengan las referencias. También se puede exportar todo en un `.zip`.
