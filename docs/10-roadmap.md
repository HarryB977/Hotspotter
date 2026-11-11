# 10 · Versiones

Decidido con el usuario: las funcionalidades se reparten en versiones usables. El contenido de cada una lo propuso el constructor y se puede mover.

| Versión | Contenido | Para qué sirve |
|---|---|---|
| **v0.1** | Importar set PBR · análisis de estructura (periodo, piezas) · layouts preset y automático · regla de proporciones · daño **realista** (macro, pieza, fractura, micro; sustrato "interior del material" y segundo set) · máscara B/N opcional · suciedad y escorrentía básicas · comprobaciones de cobertura, islas, normal, proporciones y sangrado · vista principal (pila + inspector, atlas 2D, vista 3D) · exportación **Unity (URP/HDRP) + tabla Anvil** + `.hotspot.json` · `.exe` portable · aviso de actualizaciones | Primer hotspot usable en Unity con Anvil CSG |
| **v0.2** | Estilos **estilizado** y **pixel art** · layout **manual** · bandas (pared a dos colores, zócalos) · variantes de material sobre el mismo layout · resto de comprobaciones · presets Blender/Maya, Unreal, Source 2 (`.rect`), JSON ProBuilder · librería de materiales | Cubrir todos los estilos y motores |
| **v0.3** | **IA local**: gestor de modelos, sidecar, generar tileable desde cero, inpainting de bordes | Crear sin tener material de partida |
| **v0.4** | **Vista de nodos** y nodos avanzados | Control total para artistas |

Aunque la vista de nodos llega en la v0.4, el documento es un grafo desde la v0.1 (ver [02-architecture.md](02-architecture.md)). Así la pila nunca hay que reescribirla.
