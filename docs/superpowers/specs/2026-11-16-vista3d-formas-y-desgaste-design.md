# Vista 3D: formas realistas, partes con textura y desgaste visible

Diseño acordado con el usuario el 2026-11-16, tras probar la v0.1-C con el material de ladrillo (`samples/pbr/bricks wall 13`). Se apoya en la vista 3D de la v0.1-C (decisiones 78–80) y en el encaje de ProBuilder (decisión 79, R46).

## Por qué

La vista 3D sirve para ver un hotspot sobre geometría parecida a la de los mapas reales del usuario. Al probarla aparecieron cuatro problemas:

1. **La pared con huecos está partida en seis trozos por lado.** Cada trozo recibe su propio rectángulo, así que se ven bordes de desgaste y saltos de ladrillo entre trozos. En sus mapas, el usuario hace una pared así como una sola pieza con huecos, y cada hueco (puerta, ventana, conducto) lleva un **marco que sobresale, solapa la pared y forra todo el interior del hueco**. Por eso no hace falta que se note si la pared tiene borde gastado en el hueco, y el material de la pared casi nunca aparece en el interior del hueco.
2. **Las caras pequeñas no respetan el tamaño del ladrillo.** Las jambas, el dintel, el alféizar y los trozos de encima y debajo de la ventana salen con ladrillos diminutos. Los trozos se arreglan con la pared de una pieza, y el interior del hueco con los marcos.
3. **Faltan columnas pegadas a la pared** en «Pared con huecos» y en «Pasillo».
4. **Apenas se aprecia el desgaste** en las esquinas salientes, por ejemplo en el cubo. Investigado: el desgaste se genera bien, pero se ve poco por tres causas que se suman:
   - el alcance por defecto es estrecho: 4 cm, con intensidad 0.5;
   - la vista 3D lee el atlas de la vista previa (1024 px para 8 m), así que 4 cm son unos 5 texels;
   - el cubo usa un rectángulo de 2,8 × 2,6 m encogido a 2 m.

   El usuario espera que en una esquina saliente de ladrillo la rotura se coma **más o menos medio ladrillo**.

## Objetivos

### Formas de prueba

- **Pared con huecos:**
  - Cada lado de la pared (frente y espalda) es **una sola cara con agujeros**. Recibe un único rectángulo, mapeado como lo haría ProBuilder sobre una cara con agujeros: el rectángulo se ajusta a la caja de la cara y los huecos simplemente no tienen triángulos.
  - La puerta (1 × 2,1 m) y la ventana (1,2 × 1 m, alféizar a 1 m) llevan un **marco**.
    - El marco sobresale de la pared por las dos caras, solapa el borde del hueco y forra su interior: cuatro lados en la ventana y tres en la puerta.
    - Ya no hay jambas, dintel ni alféizar de pared: el marco los sustituye.
  - Lleva **columnas** pegadas a la pared.
- **Pasillo:**
  - Lleva **columnas** pegadas a las dos paredes.
  - El rodapié se mantiene.
  - Cada pared sigue siendo una sola cara.
- **Columnas:**
  - Son prismas rectangulares del suelo al techo, pegados a la pared, sin base ni capitel.
  - Imitan la pared: llevan la misma textura y cada cara visible recibe su propio rectángulo, igual que en el motor.
- **Cubo, Columna y Escalera** no cambian de geometría.

### Partes con textura

- Cada forma se divide en **partes con nombre**: Pared, Marcos, Rodapié, Columnas, Suelo, Techo, y las que tenga cada forma.
- En la barra de la vista 3D, el usuario **elige qué partes llevan la textura del hotspot**. Las demás se pintan con un **material neutro**: gris liso algo rugoso, que no distrae.
- Así, si el usuario está haciendo una madera para marcos, marca solo Marcos y la pared queda neutra.
- **Por defecto**, Marcos y Rodapié son neutros y el resto lleva la textura. Los marcos y el rodapié nunca llevan la textura «de primeras».
- El encaje de rectángulos (decisión 79) se aplica a todas las caras con textura, de cualquier parte.

### Desgaste visible

- **El alcance por defecto del desgaste se calcula a partir del tamaño de pieza** que detecta el análisis de estructura: es la mitad de una pieza. En ladrillo, medio ladrillo.
  - **Cambiado durante la ejecución (R3, decisión 86):** medido, con alcance de media pieza la rotura típica no llegaba al objetivo (mejor mediana 0,224 del lado largo), porque la caída del sombreador deja la rotura mediana muy por debajo del alcance. Lo construido propone **alcance = 1,0 × lado largo, tamaño de rotura = 1,5 × lado corto e intensidad 0,75**. El resultado visible es una rotura típica de esquina de aproximadamente un tercio de pieza, y las roturas más profundas se acercan a una pieza entera. El alcance es el máximo, no la rotura típica.
  - Los materiales sin piezas (continuos o direccionales) conservan el valor fijo actual.
  - El cálculo funciona como la propuesta de familia (`proposeFamily` y `userSetFamily`): se propone al importar y al analizar, y en cuanto el usuario toca el alcance, se respeta su valor.
- **Lo que cuenta es el resultado, no el número** (decisión del constructor). Que en una esquina saliente se vea rota del orden de medio ladrillo.
  - El alcance (`widthM`) solo es lo más lejos que llega el daño. Con piezas, el sesgo hacia las juntas concentra la rotura a menos de `sizeM` (3 cm) de una junta, así que subir solo el alcance podría no notarse.
  - Por eso, a partir del tamaño de pieza se proponen a la vez el alcance y el tamaño de rotura (`sizeM`), y lo que haga falta de intensidad o profundidad.
  - Una prueba lo mide: en la banda de esquina de un rectángulo de ladrillo se pierde del orden de medio ladrillo.
  - Las comprobaciones de cobertura e islas siguen pasando (regla 3).
- **Proyectos guardados antes de este cambio** (decisión del constructor): al abrirlos conservan su alcance y su tamaño de rotura, y se marcan como elegidos por el usuario, para no cambiar algo que quizá dejó a propósito. Los valores propuestos solo se aplican al importar un material nuevo o con un proyecto nuevo.
- El hotspot gasta igual los cuatro bordes de cada rectángulo, porque no sabe qué borde será una esquina saliente. Así funcionan Anvil y Unity, y no se cambia. Las juntas planas las tapará otra geometría: marcos, columnas o rodapiés.
- **La vista 3D muestra el atlas con más detalle que la vista previa 2D**, al menos 2048 px, para que una banda de unos 10 cm ocupe decenas de texels y no la borre el filtrado. El usuario prefiere calidad a velocidad.

### Presets de hotspot

- **La altura de planta es 2,6 m** (decidido con el usuario).
  - El preset de paredes y las formas de prueba la usan: las paredes, columnas y el Pasillo miden 2,6 m de alto en lugar de 3 m.
  - Hay que **dejarlo escrito para quien modela los mapas**: las paredes deben medir más o menos 2,6 m para que la textura encaje bien. Va en docs/03, en una guía corta de modelado para el hotspot de paredes, y en la descripción del preset en la interfaz (tooltip del selector de preset).
- **El preset de paredes cubre paredes de altura de planta.** Las paredes grandes, como las del Pasillo, no deben estirar un rectángulo pequeño. Ya estaba decidido para la v0.1-D como «franja horizontal de altura de planta».
- **El preset de paredes tiene una franja vertical estrecha para pilares**, para que los ladrillos de una cara de columna (unos 30–40 cm × 2,6 m) tengan el mismo tamaño que en la pared.
- **El cubo de 2 × 2 m también tiene que ver el ladrillo a su tamaño** (decidido con el usuario), así que el preset necesita un rectángulo adecuado para él.
- **Tolerancia de tamaño de ladrillo: 5–10 %** (decidido con el usuario). En todas las caras con textura de las formas de prueba, el ladrillo debe salir entre un 5 y un 10 % del tamaño real, como mucho: pared con huecos, Pasillo, columnas y cubo.
  - El encaje de ProBuilder admite hasta ±25 %, pero elige el rectángulo que mejor puntúa. Con suficientes tamaños cerca de los que se modelan, la elección cae dentro del 5–10 %.
  - Se acepta rehacer el preset de paredes y dedicar más espacio del atlas a estos tamaños.
  - Las dimensiones de las formas de prueba se pueden ajustar a medidas típicas de los mapas reales (altura 2,6 m, anchos de pared habituales) en vez de forzar el preset a medidas arbitrarias.

## No objetivos

- No se cambia el criterio de encaje: sigue siendo el de ProBuilder (decisión 79). Lo que cambia son la geometría, las partes y el preset.
- No hay desgaste según el ángulo de la esquina en el modelo. El atlas no conoce el modelo.
- No se añaden formas nuevas, aparte de columnas y marcos dentro de las existentes.
- El sesgo del desgaste por relieve sigue en la v0.2 (docs/10).

## Anti-objetivos

Esto sería un fracaso aunque funcionase técnicamente:

- Que la pared con huecos siga viéndose a trozos, con bordes de desgaste en medio de la pared.
- Que los marcos o el rodapié salgan con la textura del material sin que el usuario lo pida.
- Que los ladrillos de columnas o paredes grandes salgan de un tamaño claramente distinto al de la pared, con la textura nueva aplicada.
- Que la vista 3D enseñe algo que el motor no haría con el `.hotspot.json` exportado. La vista 3D tiene que seguir siendo una vista previa fiel.

## Restricciones

- Las reglas de producto de CLAUDE.md se mantienen, sobre todo la 1 (proporciones) y la 2 (un único campo de altura).
- Los presets son árboles de guillotina sobre un atlas cuadrado de 8 m, en centímetros enteros (`packages/core/src/presets.ts`).
- Una franja repetible (`tileU`/`tileV`) tiene que cruzar el atlas entero (`validateLayout`, `layout.ts:68`, igual que `GetTilingAxis` de ProBuilder).
  - Una franja horizontal y una vertical que crucen las dos el atlas entero se cortan, así que **no pueden convivir en el mismo preset tal cual**. Ver «Lo que queda para el constructor».
- La vista 3D sigue renderizando a demanda, se pausa cuando está oculta y lee de la GPU como dice la decisión 80.
- El preset de paredes cambia los rectángulos que reciben los proyectos existentes que lo usan. Los `.hsp` guardan el preset por id, no los rectángulos, así que al abrir un proyecto viejo saldrá el preset nuevo.
- Textos de la interfaz en español; código y comentarios en inglés.

## Decidido con el usuario

- La pared es una sola pieza con huecos. Los huecos llevan marco, que forra el interior.
- El material de la pared casi nunca va en el interior del hueco.
- Hay que poder elegir qué partes del modelo llevan la textura. Marcos y rodapié no la llevan de primeras.
- Columnas rectangulares, del suelo al techo, con el mismo aspecto que la pared, en «Pared con huecos» y en «Pasillo».
- Desgaste de unos «medio ladrillo» en esquinas salientes. El alcance por defecto se calcula a partir del tamaño de pieza.
- Se añade al preset de paredes una franja vertical para pilares, además de la franja de altura de planta decidida antes.
- Altura de planta 2,6 m, documentada para quien modela los mapas.
- Tamaño de ladrillo con un 5–10 % de diferencia como mucho entre caras, incluido el cubo de 2 × 2 m.
- RepeatWrapping en todas las caras (decisión 80, confirmado).

## Decisiones del constructor (sin confirmar con el usuario)

- **Marco:**
  - Moldura de sección rectangular, de unos 8–10 cm de ancho en la cara de la pared, que sobresale 2–3 cm por cada cara.
  - La ventana no lleva alféizar aparte; la puerta no lleva marco abajo.
- **Columnas:**
  - Unos 30–40 cm de ancho y unos 15 cm de saliente.
  - En «Pared con huecos», una en cada extremo, sin pisar los huecos.
  - En el «Pasillo», a intervalos regulares en las dos paredes, por ejemplo cada 2 m.
- **Material neutro:** gris medio liso, rugosidad alta, sin metal.
- **Dónde se recuerda la elección de partes:** en `localStorage`, con el resto de ajustes de la vista 3D (`hs.view3d`), no dentro del proyecto. El usuario no contestó a esta pregunta.
- **«Mitad de una pieza»:** se toma como la mitad del lado largo típico (mediana) de las piezas detectadas, medido en el sentido de la hilada.

## Lo que queda para el constructor

- **Cómo rehacer el preset de paredes** para cumplir la tolerancia del 5–10 % con la altura de planta de 2,6 m, los pilares y el cubo, dada la restricción de que una franja repetible cruza el atlas entero.
  - Una salida es usar rectángulos no repetibles del tamaño adecuado: una banda de 2,6 m de alto con rectángulos anchos de pared y varios estrechos de pilar.
  - Otra salida es que una de las dos (altura de planta o pilares) sea franja repetible y la otra no.
  - Elegir la que cumpla la tolerancia en las formas de prueba sin malgastar el atlas, y documentarla en docs/09.
  - Las caras laterales de las columnas (el saliente, unos 15 cm) también tienen que cumplirla.
- Cómo triangular una cara con agujeros (three `ShapeUtils` o similar) y cómo representar en `ShapeFace` la cara con agujeros y la parte a la que pertenece. `FaceQuad` y `matchHotspot` siguen trabajando con el rectángulo de la cara.
- De dónde lee la vista 3D el atlas de más detalle. La evaluación de comprobaciones ya compone a `EVAL_RES` = 2048 (`store.ts`), y puede que sirva. Hay que medir el coste y que no bloquee el hilo principal (decisión 80).
- El diseño exacto del control de partes en la barra de la vista 3D: denso, que quepa en una fila o en un desplegable.
- Las pruebas: tamaño de ladrillo comparable entre pared, columna y pared grande; una sola cara por lado en la pared con huecos; marcos y rodapié neutros por defecto; alcance de desgaste propuesto a partir de las piezas.
