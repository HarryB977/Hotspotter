# 10 · Versiones

Decidido con el usuario: las funcionalidades se reparten en versiones usables. El contenido de cada una lo propuso el constructor y se puede mover.

| Versión | Contenido | Para qué sirve |
|---|---|---|
| **v0.1** | Importar set PBR · análisis de estructura (periodo, piezas) · layouts preset y automático · regla de proporciones · daño **realista** (macro, pieza, fractura, micro; sustrato "interior del material" y segundo set) · máscara B/N opcional · suciedad y escorrentía básicas · comprobaciones de cobertura, islas, normal, proporciones y sangrado · vista principal (pila + inspector, atlas 2D, vista 3D) · exportación **Unity (URP/HDRP) + tabla Anvil** + `.hotspot.json` · `.exe` portable · aviso de actualizaciones | Primer hotspot usable en Unity con Anvil CSG |
| **v0.2** | Estilos **estilizado** y **pixel art** · layout **manual** · bandas (pared a dos colores, zócalos) · variantes de material sobre el mismo layout · resto de comprobaciones · presets Blender/Maya, Unreal, Source 2 (`.rect`), JSON ProBuilder · librería de materiales | Cubrir todos los estilos y motores |
| **v0.3** | **IA local**: gestor de modelos, sidecar, generar tileable desde cero, inpainting de bordes | Crear sin tener material de partida |
| **v0.4** | **Vista de nodos** y nodos avanzados | Control total para artistas |

## Pendiente tras probar la v0.1-A (2026-11-12)

Lo encontró el usuario al probar la v0.1-A. Entra en la v0.1 (plan v0.1-B):

- **Importar archivos sueltos**: botón de selección múltiple además del de carpeta, y elegir entre **añadir** al material actual o **reemplazarlo** (ver [03](03-material-and-layout.md#importar-un-material)).
- **Orientación del material**: rotación base y regla por rectángulo (fija o seguir el eje largo), con el periodo girado en el arranque en junta y en las comprobaciones (ver [03](03-material-and-layout.md#escala-y-proporciones-regla-dura)). Hace falta para que las tablas casen con jambas y dinteles.

## Para la v0.2 (pedido por el usuario, 2026-11-12)

- **Sesgo por relieve del desgaste**: que la decisión de dónde se rompe tenga en cuenta la altura y la curvatura del material. Lo que sobresale y las aristas convexas se gastan más; lo hundido queda protegido. Un valor 0–1 por material. En la v0.1 el height solo interviene de forma indirecta (juntas y piezas, escultura de la rotura, AO y suciedad).

La exportación para Blender/Maya, Unreal y Source 2 ya estaba prevista en la v0.2. En la v0.1 solo están Unity y Anvil porque son el destino prioritario.

Aunque la vista de nodos llega en la v0.4, el documento es un grafo desde la v0.1 (ver [02-architecture.md](02-architecture.md)). Así la pila nunca hay que reescribirla.
