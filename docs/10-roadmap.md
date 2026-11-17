# 10 · Versiones

Decidido con el usuario: las funcionalidades se reparten en versiones usables. El contenido de cada una lo propuso el constructor y se puede mover.

| Versión | Contenido | Para qué sirve |
|---|---|---|
| **v0.1** | Importar set PBR · análisis de estructura (periodo, piezas) · layouts preset y automático · regla de proporciones · daño **realista** (macro, pieza, fractura, micro; sustrato "interior del material" y segundo set) · máscara B/N opcional · suciedad y escorrentía básicas · comprobaciones de cobertura, islas, normal, proporciones y sangrado · vista principal (pila + inspector, atlas 2D, vista 3D) · exportación **Unity (URP/HDRP) + tabla Anvil** + `.hotspot.json` · `.exe` portable · aviso de actualizaciones | Primer hotspot usable en Unity con Anvil CSG |
| **v0.2** | Estilos **estilizado** y **pixel art** · layout **manual** · bandas (pared a dos colores, zócalos) · variantes de material sobre el mismo layout · resto de comprobaciones · presets Blender/Maya, Unreal, Source 2 (`.rect`), JSON ProBuilder · librería de materiales | Cubrir todos los estilos y motores |
| **v0.3** | **IA local**: gestor de modelos, sidecar, generar tileable desde cero, inpainting de bordes | Crear sin tener material de partida |
| **v0.4** | **Vista de nodos** y nodos avanzados | Control total para artistas |

## Pendiente tras probar la v0.1-A (2026-11-12): hecho en la v0.1-B

Lo encontró el usuario al probar la v0.1-A y entró en el plan v0.1-B:

- [x] **Importar archivos sueltos**: botón de selección múltiple además del de carpeta, y elegir entre **añadir** al material actual o **reemplazarlo** (ver [03](03-material-and-layout.md#importar-un-material)).
- [x] **Orientación del material**: rotación base y regla por rectángulo (fija o seguir el eje largo), con el periodo girado en el arranque en junta y en las comprobaciones (ver [03](03-material-and-layout.md#escala-y-proporciones-regla-dura)). Hace falta para que las tablas casen con jambas y dinteles.

## Estado de la v0.1 (2026-11-13)

Hecho en la v0.1-A y la v0.1-B: importación (carpeta, archivos sueltos, añadir o reemplazar), análisis de estructura, orientación, layouts preset y automático, bisel propio, desgaste realista sobre un único campo de altura (seis familias), sustrato interior y segundo set, máscara B/N, suciedad de cavidad y escorrentía, las seis comprobaciones de la v0.1, export Unity URP/HDRP con `_WearMask`, `_RectID`, `.hotspot.json` y tabla Anvil, y el banco de pruebas (`npm run bench`, ver [11](11-test-bench.md)).

## Estado tras la v0.1-C (2026-11-16)

Hecho en la v0.1-C:

- [x] **Vista 3D** de la vista principal (three.js): formas de prueba, encaje de hotspot con el criterio de ProBuilder, vistas iluminada, por mapa y de rectángulos (decisiones 79 y 80).
- [x] **Pila de capas** e **inspector** que sigue a la pila; reparto Atlas 2D | Vista 3D con divisor y maximizar (decisiones 76–78).
- [x] **Guardar y abrir proyectos** `.hsp` con la máscara B/N y el segundo material (decisiones 73–75 y 82).
- [x] Análisis de estructura (≈1.3 s) y `runChecks` (≈0.5–0.7 s) en un **Web Worker** (decisión 83): ya no bloquean el hilo principal.
- [x] Aplazado de la revisión final de la v0.1-B (2026-11-13), hecho (decisión 72):
  - [x] La pasada de color compila una pipeline nueva por cada longitud de escorrentía y resolución (la clave incluía `lookback`). `LOOKBACK_ROWS` y `CHUNK_ROWS` van ahora por uniform.
  - [x] Quitadas las esperas fijas de 200 ms de `structure.spec.ts` (comprobaciones negativas); se espera a una señal de análisis terminado.
  - [x] `readbackRgba16f` a 2048 devuelve la pendiente por píxel en lugar de los cuatro canales.

- [x] **Vista 3D: formas, partes y desgaste** (decisiones 85–88): preset de paredes con franja de altura de planta (2,6 m) y de pilar; pared con huecos en una sola pieza por lado (caras con huecos abiertos); marcos, columnas y rodapié como partes; menú "Partes" con textura o material neutro; propuesta de alcance y tamaño de rotura de desgaste a partir del tamaño de pieza (alcance = 1,0 × lado largo, tamaño de rotura = 1,5 × lado corto, intensidad 0,75); vista 3D compuesta a 2048 px.

Falta para cerrar la v0.1 (plan v0.1-D):

- ~~**`.exe` portable** y **aviso de actualizaciones**~~ Hecho (v0.1-D, decisiones 90–98; ver [08](08-distribution.md)): `npm run portable`, workflow de release por tag y aviso en la barra de estado. Falta que el usuario haga el ensayo del workflow y publique la primera versión.
- Islas: marcar también las motas sueltas dentro de la franja `wEff` (decisión 51).
- Comprobar en Anvil si `Can mirror` es un solo flag para los dos ejes (decisión 54).
- ~~**Preset de paredes: franja de altura de planta**~~ Hecho (decisión 85): franja `tileU` de 2,6 m para toda pared de planta, rectángulos de pilar y de cubo; el ladrillo de las formas de prueba y de las paredes de planta sale con un 10 % de diferencia como mucho. El `RepeatWrapping` de la decisión 80 queda confirmado por el usuario.
  - **Contrapartida (regla R2):** las paredes de planta toman la franja a escala exacta, así que **no tienen bordes verticales desgastados por el hotspot**; la franja solo desgasta arriba y abajo, y sus extremos no llevan junta, bisel ni desgaste (decisión 89), así que las paredes de más de 8 m se repiten sin costura de desgaste. El material puede notar una costura cada 8 m si 8 m no es múltiplo de su tile. Las esquinas salientes se apoyan en columnas y marcos, que cubren las uniones.
- Vista 3D, menores: el interruptor "Píxeles" vuelve a subir las seis texturas de golpe; la vista 3D no avisa si el contexto WebGL nunca se recupera. (Los zócalos del Pasillo ya no se ven estirados: el preset de paredes ya no estira el Pasillo, que mide 6 × 2,6 m.)
- `inset`: no es un fallo. Se escribe en px de la textura exportada, porque la exportación resuelve el layout a la resolución de exportación (`encode.ts` → `document.ts`), y hoy vale siempre 0.
- Que el usuario valide los sets del banco frente a `samples/examples/` (criterio de [11](11-test-bench.md)).

Pendiente tras la revisión final de la v0.1-C:

- Si el Worker se cae durante Abrir, el proyecto se abre sin estructura y nada bloquea la exportación hasta que el usuario vuelve a analizar.
- Las ediciones hechas mientras se abre un proyecto se pierden sin avisar.
- Un Worker que no responde nunca dejaría colgada la exportación.
- Accesibilidad del divisor (Home/End, `aria-controls`) y `focus-visible` en los botones de maximizar.
- Cosmética del interruptor de la pila de capas (franja muerta, hover).
- Faltan tests: `localStorage` que lanza, `pointercancel`, los límites 20/80, el tope total de 1 GiB y las dimensiones completas de la columna y las escaleras.
- Validar en el pipeline la pasada de pendiente, y las esperas por inactividad de `structure.spec.ts`.

Pendiente tras la revisión final de la vista 3D, formas y desgaste (2026-11-17):

- En el modo Rectángulos, los contornos de los rectángulos no se recortan por los huecos de la cara.
- Al cerrar el menú Partes con Escape, el foco no vuelve al botón Partes.
- Si la composición 3D falla, no se muestra ningún mensaje: debería volver al atlas de la vista previa y avisar.
- Ningún test cubre que Abrir o Nuevo sustituyan una composición 3D en marcha.
- Con la vista previa a 1024, cada cambio hace dos composiciones a 2048; la evaluación podría reutilizar el atlas 3D.
- El test del límite de búfer de la exportación (`app.spec.ts:362`) falla a veces con la máquina cargada.
- Las bandas de desgaste de arriba y abajo de una franja repetible usan ruido no periódico: donde la franja se repite, su patrón de rotura cambia de golpe (decisión 89).

Pendiente tras la revisión final de la v0.1-D (2026-11-17):

- «Omitir esta versión» tiene una carrera: `skip` y una comprobación en curso leen y guardan `updates.json` por separado, así que la última en guardar puede pisar la omisión y el aviso reaparece.
- La ventana de notas del aviso de actualización solo se cierra con el botón «Notas»: falta cerrarla con Escape y con un clic fuera.
- El empaquetado inyecta con postject en una copia de `node.exe` que conserva su firma Authenticode, ya inválida tras la inyección; habría que quitarla antes de inyectar.
- Dos copias lanzadas exactamente a la vez pueden pasar ambas la comprobación de `instance.json` antes de que ninguna lo escriba; el efecto es un segundo servidor en otro puerto.

## Para la v0.2 (pedido por el usuario, 2026-11-12)

- **Deshilachado** (papel, tela, césped) como familia de desgaste (decisión 56).
- **Sesgo por relieve del desgaste**: que la decisión de dónde se rompe tenga en cuenta la altura y la curvatura del material. Lo que sobresale y las aristas convexas se gastan más; lo hundido queda protegido. Un valor 0–1 por material. En la v0.1 el height solo interviene de forma indirecta (juntas y piezas, escultura de la rotura, AO y suciedad).

La exportación para Blender/Maya, Unreal y Source 2 ya estaba prevista en la v0.2. En la v0.1 solo están Unity y Anvil porque son el destino prioritario.

Aunque la vista de nodos llega en la v0.4, el documento es un grafo desde la v0.1 (ver [02-architecture.md](02-architecture.md)). Así la pila nunca hay que reescribirla.
