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

### Pasada de pérdida (dónde se rompe)

El motor decide primero qué píxeles pierden material y a qué profundidad objetivo (en metros). Ambos valores van en el mapa `loss` (r32uint con `pack2x16float(pérdida, profundidad)`). Sin desgaste, `loss` es un marcador de 1×1 a 0: un `loss` de 1×1 significa "sin desgaste". El export no escribe `loss`, `pieceId` ni `jointDistM` y los libera nada más componer.

Todo se mide en metros sobre coordenadas locales del rectángulo, así que la preview y el export coinciden a cualquier resolución. A esas coordenadas se suma un desplazamiento por rectángulo, derivado de la seed y del **índice** del rectángulo en el layout: reordenar los rectángulos cambia su desgaste.

- El potencial de daño cae con la distancia al borde visible del rectángulo (el borde del fondo de ranura) en un ancho `wEff = min(widthM, 0.33 · lado menor visible)`. El lado menor visible es el del rectángulo menos el fondo de ranura. Así los trims finos no quedan comidos.
- La máscara B/N lo modula (gris medio = neutro, decisión 43). Con piezas, `pieceBias` lo concentra a menos de `sizeM` de una junta, con un peso aleatorio por pieza.
- La forma sale de una mezcla de fBm y celdas Voronoi (`cellMix` de la familia). La celda se parte en cada junta, así que la rotura sigue el contorno de las piezas. Las celdas se estiran (`anisotropy`) a lo largo de la veta del material, o de su eje X si no hay veta, y giran con el rectángulo.
- Siempre se pierde un borde mínimo irregular. Su ancho base es `min(minEdgeM, 0.5 · wEff)` (en trims finos manda el límite) y el contorno interior llega hasta 1.6 veces ese ancho.
- `dent` y `edgeOnly` no pierden material; `dent` solo deja una profundidad suave en G.
- Sin desgaste, `loss` vale 0 en todo el atlas. La ranura siempre vale 0.

### Pasada de altura (cómo se rompe)

Con la pérdida ya decidida, el motor esculpe el daño en el campo de altura único. Sin desgaste esta pasada no se ejecuta y la salida es idéntica byte a byte a la de la v0.1-A.

1. **Distancia al contorno (`border`, r32float).** Es la distancia con signo, en metros, al contorno de la pérdida: negativa dentro y limitada a ±4·`bandM`. Se calcula con jump flooding desde los puntos medios entre píxeles vecinos a ambos lados del contorno, del mismo rectángulo y fuera del fondo de ranura. Como la distancia está limitada, el primer salto es `nextPow2(⌈4·bandM·ppm⌉ + 1)` y no la mitad de la textura, y al final se repite un salto de 1. Las semillas van en dos texturas r32uint (x | y << 16 en medios píxeles), la mitad de memoria que rg32sint, y se liberan nada más terminar.
2. **Altura.** `s = smoothstep(0, bandM, −b)`:
   - En la pérdida (`b < 0`): `h = hMat − depth·s + microM·(fbm(local / 2 mm) − 0.5)·s`. La rugosidad de la rotura entra con el mismo perfil, así que el contorno no tiene escalón.
   - En la banda de fractura (`0 < b < bandM`): `h −= 0.15·depth·crack·envolvente`, con `crack = 1 − smoothstep(0, 0.15, d2 − d1)` de un Voronoi de celda `0.25·bandM`. La envolvente vale 0 en el contorno y en el final de la banda, de modo que las grietas finas rodean cada rotura sin dejar saltos de un píxel.
   - Las familias sin pérdida de capa (`dent`) solo hunden la superficie con su profundidad suave.
   - Límites: `h ≥ hMat − depthM − 0.5·microM` (el fondo de la rotura conserva rugosidad micro), y una rotura nunca baja del fondo de ranura: `h ≥ min(hMat, −grooveDepthM)`.
   - Las grietas tienen al menos un píxel de ancho: el ancho del smoothstep es `max(0.15, mpp / (0.25·bandM))` y la amplitud se escala por `0.15 / ancho`.
3. **Altura macro** (`macroHeight`, r32float) = ranura y bisel + `(h − hMat)`, es decir, todo salvo el relieve del material intacto. Si el material trae normal map, la normal sale del Sobel de esta altura y la normal de detalle del material se desvanece hacia (0,0,1) según `wearMask`: lo que se rompe se lleva su relieve.
4. **`wearMask`** (rgba8unorm, gris) = `s`. Es la pérdida suavizada con el mismo perfil que la altura: 0 en el contorno y fuera de la pérdida, y 1 a partir de `bandM` hacia dentro. Se puede exportar.

**El fondo de ranura nunca se desgasta** (R31). Sus píxeles dentro de un rectángulo (fuera del borde visible) llevan en `loss` la marca `lossR = −1`, que todo lector trata como 0. No reciben pérdida, profundidad, cambio de altura ni `wearMask`, y no siembran contorno. El contorno solo se forma entre píxeles del mismo rectángulo, así que no se cuela de un rectángulo a otro. El desgaste empieza en el borde visible hacia dentro, bisel incluido. La ranura sigue siendo el separador limpio que detecta Anvil.

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
