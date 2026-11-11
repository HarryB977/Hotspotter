# 04 · Desgaste de borde

Es la parte que peor salió en el generador de ProBuilder y la razón principal de este proyecto.

## Lo que falló antes (referencia: `com.harryb97.tools.probuilderextensions`)

- El daño era una máscara 2D en el borde del rectángulo, ajena al material. Con ladrillo encima y cemento debajo, el cemento que asomaba no era el de las juntas y se veía raro.
- La transición entre la zona dañada y la intacta no tenía sentido físico: faltaba la rotura alrededor y el salto de normal resultaba extraño.
- Hubo que ir poniendo parches: tramos del borde sin daño (de ahí el "Edge Width mínimo"), motas sueltas, detalle más fino que un píxel que se rompía y solo tres estilos fijos (Cracks / Bites / None).

## Principios (decididos con el usuario)

1. **El daño nace de la estructura del material.** Si hay piezas, se rompen piezas concretas: esquinas y aristas de un ladrillo, una baldosa desconchada, un tablón astillado. La junta se erosiona y se hunde. Lo que queda al descubierto es coherente con lo que hay encima.
2. **La transición es geometría, no una mezcla.** Todo el daño se esculpe sobre **un único campo de altura**. Normal, AO, cavidad y curvatura se recalculan siempre a partir de ese campo, combinados con el detalle original del material. Normal y relieve no pueden contradecirse.
3. **Comprobaciones automáticas** antes de dar un resultado por bueno (ver abajo). Si una falla, se avisa, y si tiene corrección automática se ofrece.
4. **Máscara B/N opcional** del usuario, que guía dónde y cuánto daño hay. No es una franja que se repite, como en ProBuilder; modula al algoritmo procedural.

## Modelo

Por cada píxel del atlas el motor conoce: el rectángulo al que pertenece, la distancia con signo a su borde, el ID y la SDF de pieza del material (si hay piezas), la altura original y la normal original.

El daño se construye por capas de escala, todas en unidades del mundo:

| Escala | Qué es | Ejemplos |
|---|---|---|
| Macro | Volumen perdido en el borde del rectángulo: bisel, redondeo, golpes grandes | canto romo, esquina arrancada |
| Pieza | Roturas que siguen la geometría de las piezas cercanas al borde | ladrillo con esquina rota, azulejo sin esmalte, tablón astillado a lo largo de la veta |
| Fractura | Banda alrededor de cada rotura: grietas finas, escalones, desconchado en capas | aureola de pintura levantada alrededor de un golpe |
| Micro | Rugosidad de la superficie rota, distinta de la superficie intacta | grano del interior del ladrillo, metal arañado |

Cada capa resta del campo de altura. Una rotura siempre lleva su banda de fractura, para que nunca haya un corte limpio sin contexto. La profundidad tiene un límite físico: no se puede perder más de lo que mide la pieza.

### Qué queda debajo ("sustrato")

Lo que aparece donde se pierde material sale de una de estas fuentes:

- **Interior del propio material** (por defecto): albedo con otro tono, saturación y roughness, ruido de grano. Sirve para ladrillo, piedra, cerámica sin esmalte o madera sin barniz.
- **Segundo set PBR** elegido por el usuario: metal bajo la pintura, ladrillo bajo el yeso. La herramienta compara el color medio y la escala con las juntas del material superior y **avisa si no casan**, que es justo el problema del ladrillo con cemento.
- **Capas**: pintura → imprimación → metal. Cada nivel de profundidad revela una capa distinta, con borde escalonado entre ellas.

### Revelado en zona

Además del borde, la capa superior puede perderse **en manchas grandes** dentro del rectángulo, como el enlucido gastado que deja ver el ladrillo en `samples/examples/brick wall.jpg`. Las guía el ruido, la máscara B/N o la curvatura, y se esculpen en el mismo campo de altura con su banda de fractura, igual que el daño de borde. Ver [11-test-bench.md](11-test-bench.md).

### Familias de daño

Se combinan y se ponderan. El tipo de material propone una mezcla por defecto:

- Desconchado (pintura, esmalte, laca): bordes en escalón con levantamiento.
- Rotura frágil (cerámica, ladrillo, piedra, hormigón): fractura angulosa siguiendo piezas.
- Astillado (madera): roturas alargadas en la dirección de la veta.
- Abolladura y abrasión (metal, plástico): deformación suave, brillo pulido en los cantos y arañazos.
- Deshilachado y rasgado (papel, tela, césped): bordes fibrosos, pérdida de opacidad.
- Erosión (cemento, mortero, piedra blanda): pérdida granular redondeada.
- Desgaste de cantos sin pérdida (cualquier material): solo color, roughness y curvatura en las aristas.

### Más allá del borde

Son capas opcionales que se aplican después del daño: suciedad en cavidades, escorrentía vertical (respeta la orientación "arriba" del rectángulo), manchas de humedad, polvo en superficies horizontales del relieve y variación de tono por pieza.

## Estilos de daño

El material ya trae su estética; el estilo solo decide cómo se dibuja el daño.

- **Realista**: todo lo anterior, con microdetalle y transiciones físicas.
- **Estilizado**: las mismas reglas de estructura con formas simplificadas. Roturas con pocas aristas y bien legibles, sin microdetalle ruidoso, contorno opcional (oscuro o claro) en la línea de rotura, normal suavizada y escalones de altura cuantizados. La paleta se toma del material.
- **Pixel art**: el daño se genera en la **rejilla de píxeles del material** (que se detecta automáticamente y se puede corregir). No hay antialiasing ni degradados, solo colores que ya existen en la paleta del material (cuantizada) y formas que se leen en pocos píxeles. El atlas de salida es un múltiplo entero de esa rejilla y la exportación recomienda filtrado point. Un estilo "PS1" se consigue con estilizado más resolución baja y filtrado point; no es un estilo aparte.

## Comprobaciones automáticas

Se ejecutan en el render final (y en una versión barata en el preview). Se muestran en el panel de comprobaciones y se pueden marcar en el atlas:

| Comprobación | Falla si… |
|---|---|
| Cobertura de borde | un tramo del perímetro de un rectángulo más largo que X cm no tiene daño, cuando el ajuste pide daño continuo |
| Islas | hay daño desconectado del borde o de una pieza dañada (motas sueltas) |
| Coherencia de normal | la normal final se desvía de la derivada del campo de altura por encima de un umbral |
| Saltos de altura | hay un escalón de altura sin banda de fractura alrededor |
| Proporciones | una pieza está escalada o una hilada no arranca en junta (ver [03](03-material-and-layout.md)) |
| Sangrado | el contenido de un rectángulo invade la ranura o el inset de un vecino |
| Estabilidad de mip | el daño cambia de forma o desaparece entre mip 0 y mip 2 (detalle menor que un píxel) |
| Sustrato | el color o la escala del sustrato no casan con las juntas del material superior |
| Tileado de trims | una franja `tileU/V` no encaja en los extremos |
| Pixel art | aparecen colores fuera de la paleta o píxeles que no siguen la rejilla |

## Variedad

Seed global más seeds por rectángulo, desplazamiento del material por rectángulo, mezcla de familias, escalas y la máscara B/N. Dos proyectos con parámetros distintos deben dar atlas que no se parezcan: no puede haber patrones fijos, texturas de ruido incluidas que se repitan ni formas de rotura de una biblioteca pequeña. Todo el ruido es procedural y se evalúa en coordenadas del mundo con dominio deformado.
