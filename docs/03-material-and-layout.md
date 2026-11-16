# 03 · Material, estructura y layout

## Importar un material

- Se arrastran archivos o una carpeta, o se eligen con dos botones: **carpeta** y **archivos** (selección múltiple de imágenes sueltas). Si ya hay un material cargado, la herramienta pregunta si los archivos nuevos **reemplazan** el material o **se añaden** a él, por ejemplo para completar un AO que faltaba o sustituir un mapa concreto. Los mapas se reconocen por sufijos habituales (`_albedo`, `_basecolor`, `_diff`, `_nor_gl`, `_normal_dx`, `_rough`, `_metal`, `_ao`, `_height`, `_disp`, `_opacity`…) y el usuario puede corregir la asignación.
- Hay que indicar o confirmar: convención de normal (OpenGL / DirectX), si roughness es en realidad gloss o smoothness (y entonces se invierte), espacio de color de cada mapa y **tamaño real** que cubre una repetición (en metros).
- Si falta un mapa, se deriva: height a partir de normal o luminancia, normal a partir de height, AO a partir de height, y valores constantes de roughness/metallic editables.
- Formatos: PNG, JPG, TGA, TIFF (8/16 bits) y EXR para height.
- **Librería de materiales**: los sets importados se pueden guardar en una librería local para reutilizarlos entre proyectos.

## Análisis de estructura

Antes de generar, la herramienta deduce la estructura del material porque la necesitan tanto el respeto de proporciones como el desgaste:

1. **Periodicidad**: autocorrelación del perfil de juntas para detectar la repetición en X e Y (por ejemplo, la altura de hilada y la longitud de ladrillo, el ancho de tablón o el tamaño de azulejo). Y sale del perfil por filas; X, de la mediana del perfil por columnas de cada hilada, así que en un aparejo a soga da la longitud del ladrillo y no el medio desfase. La **fase** es la posición, en metros desde abajo y desde la izquierda, del **centro** de una junta: un rectángulo que arranca en junta empieza en mitad de la llaga, y cada vecino se queda con media junta. Se muestra como una rejilla superpuesta que se puede editar.
2. **Piezas y juntas**: el análisis trabaja en CPU sobre el height reducido a ≤ 512 px. Si no hay height, usa la luminancia invertida del albedo. Calcula el **relieve de junta**, que mide cuánto queda cada píxel por debajo de su superficie local (cierre morfológico menos altura, en fracción del rango de alturas), de modo que las juntas se leen igual en piezas altas y bajas. Otsu sobre el relieve decide si hay juntas: hace falta un nivel de junta claro (separabilidad ≥ 0.70) y profundo (al menos un 10 % del rango). Si no lo hay, el material no tiene juntas, aunque se guarda el umbral sugerido. Otsu solo marca el núcleo más hondo de la llaga, así que la junta se segmenta con histéresis: crece desde ese núcleo hasta un umbral menos profundo, el 38 % de la profundidad de Otsu (`t_seg = 1 − (1 − t_otsu) · 0.38`, decisión 42). Un umbral del usuario fija directamente ese umbral de segmentación, sin histéresis. Los hoyos aislados (componentes de junta de menos del 0,25 % de la imagen y más cortos que el 5 % del lado mayor) no cuentan como junta. Las piezas son las regiones sin junta, con wrap en los dos ejes. Los puentes finos de un hueco en la llaga se cortan con semillas a más de 8 px de una junta, que luego vuelven a crecer. Las astillas de menos del 0,1 % de la imagen pasan a ser junta. El análisis reduce la entrada a ≤ 512 px. El resultado es un mapa de **ID de pieza** y la **distancia a la junta** en metros (EDT exacta con wrap, limitada al lado mayor del tile). Se visualiza y se corrige: unir o separar piezas, ajustar el umbral.

   En la v0.1 el análisis se lanza solo al importar el material, al cambiar su height o su albedo y al cambiar el tamaño real del tile, y otra vez con el botón **Detectar** de la sección Estructura del inspector. El campo **Umbral** muestra el umbral sugerido mientras el umbral es automático, o queda vacío ("auto") si el análisis no encontró juntas. Al cambiarlo se guarda en el nodo de estructura y se vuelve a analizar (vacío = automático); entrar y salir del campo sin cambiar el valor no guarda nada. Los análisis automáticos (importación, cambio de mapas, de tamaño del tile o de umbral) proponen el periodo y la fase del material, pero solo los aplican mientras el usuario no haya cambiado el periodo a mano (`periodUserSet`). **Detectar** es un "volver a lo detectado": aplica siempre el periodo y la fase detectados y quita la marca `periodUserSet`. Un análisis cuyo material cambia mientras espera se descarta. La pestaña **Piezas** de la barra de mapas muestra el atlas coloreado por pieza. En la GPU, el ID de pieza y la distancia a la junta se leen en la misma UV del material que el albedo (rotación incluida), en el texel más cercano y con wrap; en la ranura valen 0.
3. **Tipo de material**: con piezas (ladrillo, azulejo, tablón, adoquín), continuo (cemento, metal, plástico, yeso), fibroso o direccional (madera sin tablones, césped, tela) o por bandas (pared pintada a dos alturas, zócalo). Lo propone la herramienta y lo confirma el usuario. Decide qué reglas de proporción y qué desgaste se aplican.

Un material continuo no tiene piezas; su "estructura" es solo la dirección dominante, si la hay.

## Escala y proporciones (regla dura)

- El atlas tiene una **densidad** fija (px/m) definida por su ancho en metros (como el World Width de ProBuilder, el Sheet Width de Anvil o los "world mapping values" de Source 2).
- El material se muestrea a su tamaño real en **todos** los rectángulos. Nunca se escala por rectángulo.
- En materiales con piezas o por bandas, cada rectángulo arranca en una junta (o en la línea de banda) en el lado que se elija (por defecto, abajo a la izquierda).
- Si la medida de un rectángulo no es múltiplo del periodo del material en un eje donde importa, la herramienta lo marca. Puede **ajustarlo** al múltiplo más cercano (opción por defecto en layouts automáticos) o **avisar** sin tocarlo (opción por defecto en layouts manuales). Una pieza cortada por el borde del rectángulo se permite solo en el eje donde el usuario lo acepta, por ejemplo ladrillos cortados en vertical pero hiladas siempre enteras.
- **Bandas** (pared pintada a dos colores, zócalos): una banda es una franja horizontal a una altura del mundo fija, medida desde el borde inferior del rectángulo. Es un nodo propio que compone dos materiales o dos tintes con una línea de transición (recta, irregular o con moldura) y que respeta esa altura en todos los rectángulos lo bastante altos.
- **Orientación del material** (pedido por el usuario tras probar `wood_planks_12` con el preset Marcos): las tablas de madera deben seguir la dirección de la pieza del layout. En una jamba van en vertical; en un dintel o un alféizar, en horizontal. El material tiene:
  - **Rotación base** de 0° o 90°, para que la textura de entrada se lea en la dirección correcta.
  - **Regla por rectángulo**:
    - *Fija*: todos los rectángulos usan la misma orientación. Es lo correcto en ladrillo, donde las hiladas siempre van en horizontal.
    - *Seguir el eje largo*: la veta o las tablas van a lo largo del lado mayor de cada rectángulo. Es la opción por defecto en materiales direccionales.
    - *Por rectángulo*: se elige rectángulo a rectángulo, en el layout manual.

  Al girar un material con periodo se intercambian sus ejes (periodo X ↔ Y, fase y "permitir corte"). El arranque en junta y las comprobaciones de proporción se hacen con el periodo ya girado, así que también funcionan con periodos no cuadrados.
- **Variación** por rectángulo: cada rectángulo puede tomar un desplazamiento distinto del material (múltiplo del periodo, para no romper las juntas) y girar 90° si el rectángulo y el material lo permiten. Un valor 0–1 controla cuánto.

## Layouts

Un layout es independiente de la resolución: rectángulos en unidades del atlas, más metadatos. Por rectángulo:

| Campo | Significado |
|---|---|
| `x, y, w, h` | posición y tamaño (en píxeles a la resolución de referencia; también se muestran en metros) |
| `allowRotation` | la herramienta de destino puede girarlo 90° |
| `allowMirrorX/Y` | se puede voltear |
| `tileU / tileV` | franja que se repite a lo largo (trims); solo si ocupa todo el ancho o alto del atlas |
| `useOn` | Walls / Floors / Ceilings / Any (para Anvil) |
| `inset` | píxeles reservados contra el sangrado de mipmaps |
| `group` | etiqueta libre (por ejemplo "trim", "panel") |
| `materialOverride` | opcional: otro material o banda para este rectángulo |

### Tres modos (elige el usuario)

1. **Presets**: Walls, Floors, Trims, Frames y Generic, con los mismos criterios que los layouts de serie de la extensión de ProBuilder (interior, 8×8 m, 512 px/m por defecto, editable), más uno "Mixed" de propósito general. Las medidas exactas las decide el constructor; los de ProBuilder sirven de referencia, no hay que copiarlos.
2. **Manual**: editor 2D para dibujar, mover, dividir y unir rectángulos, con snap a una rejilla en cm y **snap al periodo del material**. Atajos al estilo del Subrect Editor de Hammer (cambiar el tamaño de rejilla con `[` y `]`).
3. **Automático**: la herramienta propone un layout a partir de un objetivo (paredes, suelos, mixto, trims), la densidad y la estructura del material. Las medidas son múltiplos del periodo y el reparto de tamaños y proporciones queda equilibrado. Es un empaquetado en guillotina, que además produce las juntas rectas largas que Anvil detecta con "Detect Grid". Se puede regenerar con otra seed o pasar a manual para retocarlo.

### Modelar para el hotspot de paredes

El preset Paredes está hecho para una **altura de planta de 2,6 m** (decisión 85). Quien modela los mapas debería ajustarse a estas medidas:

- **Paredes de 2,6 m de alto, de cualquier largo** a partir de unos 44 cm. Todas usan una franja de 2,6 m de alto que se repite a lo largo, así que el ladrillo sale a su tamaño real sea cual sea el largo. A cambio, la franja no tiene bordes verticales: las esquinas de la pared no salen desgastadas por el hotspot. Las esquinas se resuelven con columnas y marcos.
- **Pilares de 35 cm de ancho y 15 cm de saliente**, y **cantos de pared de 20 cm**. Cada una de esas tres medidas, a 2,6 m de alto, tiene su propio rectángulo.
- **Bloques de 2 × 2 m**, como el cubo de prueba, que tienen su rectángulo de 2 × 2 m.

El motivo: el hotspot elige el rectángulo por tamaño y estira la textura hasta un 25 % para que encaje. Con estas medidas, el ladrillo sale a su tamaño real, con un 10 % de diferencia como mucho. Lo que se sale de ellas se estira:

- Una cara de 2,6 m de alto y entre 12 y 44 cm de ancho que no mide 15, 20 o 35 cm (por ejemplo, un pilar de 25 o 30 cm) coge el rectángulo de pilar más parecido y se estira hasta un 25 %.
- Una pared de otra altura (por ejemplo, 3 m) usa la franja, pero estirada en vertical hasta un 25 %. Si se aleja más de eso, coge el rectángulo de forma más parecida y se estira todavía más.
- Un bloque de unos 2 m de alto y un ancho distinto de 2 m coge uno de los rectángulos de 2 m de alto (de 0,4 a 2 m de ancho) y se estira en horizontal.

### Variantes

Como en Source 2 (`concrete_painted_white_hs05a/b/c`, `_blue`…), un proyecto puede tener varias **variantes** que comparten el layout y cambian tinte, bandas, sustrato o seed de daño. Se exportan juntas, con sufijo, y una misma definición de rectángulos sirve para todas.

### Juntas entre rectángulos

El espacio entre rectángulos (la "ranura") tiene ancho del fondo plano (centrado en el borde compartido), ancho de bisel (dentro de cada rectángulo, 3 mm por defecto), profundidad y perfil configurables (bisel recto, redondeado, escalón, sin ranura). Por defecto la ranura es oscura y hundida para que Anvil detecte los rectángulos automáticamente.

Desde la v0.1-B el bisel es un parámetro propio (`groove.bevelM`, decisión 40) y no la mitad del fondo:

| Parámetro | Por defecto | Qué es |
|---|---|---|
| `widthM` ("Fondo de ranura") | 6 mm | Fondo plano, centrado en el borde compartido: medio fondo en cada rectángulo |
| `bevelM` ("Bisel") | 3 mm | Rampa dentro de cada rectángulo, desde el fondo hasta la superficie. Con `bevelM` 0 no hay bisel; con fondo 0 y bisel, la ranura es una V |
| `depthM` | 4 mm | Profundidad del fondo |

La ranura visible mide `widthM + 2·bevelM` (12 mm por defecto): es lo que mide la comprobación de sangrado (decisión 50). El fondo de ranura nunca se desgasta; el desgaste empieza en el borde visible, bisel incluido (decisión 45). Los documentos sin `bevelM` lo toman como `widthM / 2`, que era el bisel de la v0.1-A.
