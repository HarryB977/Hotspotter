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

### Parámetros de la v0.1

Viven en el nodo `wear` del documento (`packages/core/src/wear/params.ts`). Todas las longitudes se guardan en metros; la UI las muestra en cm o mm.

| Parámetro | Por defecto | UI | Qué hace |
|---|---|---|---|
| `family` | según el material | Familia | Forma del daño (ver "Familias de la v0.1"). La propone `proposeFamily` hasta que el usuario elige una (`userSetFamily`) |
| `intensity` | 0.5 (0–1) | Intensidad | Potencial de daño en el borde visible |
| `widthM` | 0.04 (4 cm) | Alcance | Hasta dónde llega el daño desde el borde visible. Se limita a `wEff`; 0 apaga el desgaste de borde, también el borde mínimo (R30) |
| `minEdgeM` | 0.004 (4 mm) | Borde mínimo | Borde que se pierde siempre, con contorno irregular |
| `sizeM` | 0.03 (3 cm) | Tamaño de rotura | Escala del ruido y de las celdas; con piezas, distancia a la junta donde se concentra el daño |
| `depthM` | 0.006 (6 mm) | Profundidad | Profundidad de la pérdida (entre 0.5 y 1 vez este valor, según ruido) |
| `bandM` | 0.006 (6 mm) | Banda de fractura | Ancho de la transición alrededor de cada rotura |
| `microM` | 0.0005 (0.5 mm) | Microdetalle | Amplitud de la rugosidad de la superficie rota |
| `pieceBias` | 0.7 (0–1) | Sigue las piezas | Cuánto se concentra el daño junto a las juntas, con un peso por pieza |
| `edgeTone` | 0.3 (0–1) | Tono de canto | Aclarado y pulido de los cantos |
| `seed` | 0 | Semilla | Semilla del daño (u32, hash PCG en GPU) |
| `mask` | apagada, fuerza 1, sin invertir | Máscara B/N | Ver la decisión 43 |
| `substrate` | interior: tono 0°, saturación ×0.7, valor ×0.8, rugosidad +0.2 | Sustrato | Lo que queda debajo (ver "Pasada de color") |

Suciedad (nodo `dirt`): `enabled` true, `cavity` 0.4, `runoff` 0 (era 0.3; decisión 69), `runoffLengthM` 0.4 m y `tint` [0.25, 0.22, 0.18]. El desgaste también lleva `enabled` (true por defecto).

### Resumen del cálculo

Por cada píxel de un rectángulo, en metros locales del rectángulo más un desplazamiento por rectángulo:

```
e     = distancia al borde visible (rect menos medio fondo de ranura)
wEff  = min(widthM, 0.33 · lado menor visible)
P     = intensity · (1 − smoothstep(0, wEff, e))           // borde
      · mix(1, 2·máscara, strength)                        // máscara B/N (si hay)
      · mix(1, cercaníaJunta · pesoPieza, pieceBias)       // solo con piezas
q     = ruido deformado(local / sizeM)
forma = mix(fbm(q), hash(celda Voronoi estirada, pieza), cellMix)
pierde = forma < P  o  e < min(minEdgeM, 0.5·wEff) · (1 + 0.6·fbm)
prof  = depthM · (0.5 + 0.5·fbm), en escalones si la familia los tiene
border = distancia con signo al contorno de la pérdida (jump flooding)
altura = hMat − prof · smoothstep(0, bandM, −border) + micro + grietas en la banda
normal = Sobel(altura macro) + normal de detalle que se desvanece con wearMask
AO     = AO_material · AO_altura;  color = sustrato, canto, cavidad y escorrentía
```

Las secciones siguientes detallan cada pasada.

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

Con la pérdida ya decidida, el motor esculpe el daño en el campo de altura único. Sin desgaste esta pasada no se ejecuta. Un test compara en la misma ejecución una composición sin desgaste con otra con desgaste que no pierde nada (`widthM` 0): todos los mapas coinciden exactamente y la normal difiere como mucho en 1 LSB.

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

### Pasada de color (color, rugosidad, metálico y AO)

Corre siempre, con desgaste y sin él, cuando la altura ya es la final. El color y la rugosidad se componen aquí y nunca entran en la normal (CLAUDE.md, regla 2). Todo se mide en metros.

- **Sustrato**, solo en familias con pérdida de capa, mezclado por `wearMask`:
  - **Interior**: HSV del color del material con `h += hueShift` (en grados), `s *= satMul` y `v *= valMul`, multiplicado por `0.9 + 0.2·fbm(local / 4 mm)`. La rugosidad suma `roughAdd`.
  - **Segundo set** (`substrate.source = 'secondSet'` con un material de sustrato cargado): se muestrea en las mismas coordenadas de material que el set superior (colocación y giro incluidos), con su propio `tileSizeM` y sin estirar. Hereda el giro de 90° (`rotate90`) y el origen del set superior en cada rectángulo: no tiene colocación propia. Aporta color, rugosidad, metálico y AO. Si se pide sin set cargado, se usa el interior.
- **Tono de canto**: `canto = max(perfil del bisel, 1 − smoothstep(0, bandM, |border|))`. Usa `|border|`, así que la banda se extiende a ambos lados del contorno, también dentro de la pérdida. El valor sube hacia 1 (`v = mix(v, 1, edgeTone·polish·canto)`) y la rugosidad baja `0.3·edgeTone·polish·canto`. Con `widthM` 0 no hay tono de canto (R30). `edgeOnly` y `dent` no tienen sustrato, solo canto.
- **AO** = AO del material × AO de altura. `AO_altura = 1 − clamp(0.7 · Σ_r max(0, media de 8 taps a radio r − h) / r)`, con r = 5, 20 y 60 mm y lectura bilineal de la altura. Sustituye al `1 − 0.5·prof` de la v0.1-A: una ranura de 4 mm con bisel de 3 mm queda cerca de 0.5 en el fondo. Si el material trae un mapa de AO de verdad, el AO de altura se calcula sobre la altura macro (ranura, bisel y desgaste): el AO horneado ya contiene el relieve del material y no se oscurece dos veces (R33). Sin mapa de AO se calcula sobre la altura total.
- **Suciedad de cavidad**: `k = cavity · (1 − AO_material · AO_altura)`; `color = mix(color, tint·color, k)` y la rugosidad suma `0.1·k`.
- **Escorrentía**: `runoffLengthM` se limita a la altura del atlas. Nace en el borde superior visible de cada rectángulo y debajo de cada pérdida del mismo rectángulo, y baja hasta `runoffLengthM`: `cantidad = runoff · (1 − smoothstep(0, L, distancia bajo el origen)) · fbm(local.x / 1 cm, local.y / L)`, con `color = mix(color, tint·color, cantidad)`. Nunca aparece por encima de su origen. Para conocer la última pérdida de encima, cada invocación recorre de arriba abajo un tramo de una columna, después de releer `runoffLengthM` por encima del tramo (solo `rectId` y `loss`).
- La ranura y el fondo de ranura no llevan sustrato, tono de canto ni escorrentía. El AO de altura y la suciedad de cavidad se aplican en todo el atlas.
- Sin `dirt` en la composición (o con la suciedad apagada) no hay suciedad (cavidad y escorrentía a 0). La suciedad funciona igual con el desgaste apagado.

### Qué queda debajo ("sustrato")

Lo que aparece donde se pierde material sale de una de estas fuentes:

- **Interior del propio material** (por defecto): albedo con otro tono, saturación y roughness, ruido de grano. Sirve para ladrillo, piedra, cerámica sin esmalte o madera sin barniz.
- **Segundo set PBR** elegido por el usuario: metal bajo la pintura, ladrillo bajo el yeso. La herramienta compara el color medio y la escala con las juntas del material superior y **avisa si no casan**, que es justo el problema del ladrillo con cemento.
- **Capas**: pintura → imprimación → metal. Cada nivel de profundidad revela una capa distinta, con borde escalonado entre ellas.

### Revelado en zona

Además del borde, la capa superior puede perderse **en manchas grandes** dentro del rectángulo, como el enlucido gastado que deja ver el ladrillo en `samples/examples/brick wall.jpg`. Las guía el ruido, la máscara B/N o la curvatura, y se esculpen en el mismo campo de altura con su banda de fractura, igual que el daño de borde. Ver [11-test-bench.md](11-test-bench.md).

### Familias de la v0.1

Una familia por proyecto (sin mezcla todavía). Valores de `WEAR_FAMILIES`:

| Familia | UI | `cellMix` | `anisotropy` | Escalones | Pierde capa | Pulido | Se propone para |
|---|---|---|---|---|---|---|---|
| `brittle` | Rotura frágil | 1 | 1 | 0 | sí | 0.2 | materiales con piezas |
| `chipping` | Desconchado | 0.6 | 1 | 2 | sí | 0.1 | continuos con "paint"/"pintur" en el nombre |
| `splinter` | Astillado | 1 | 4 | 0 | sí | 0.1 | materiales direccionales |
| `erosion` | Erosión | 0 | 1 | 0 | sí | 0 | el resto de continuos |
| `dent` | Abolladura y abrasión | 0.3 | 1 | 0 | no (hunde sin perder) | 0.6 | continuos con "metal", "steel", "iron" o "alumin" en el nombre |
| `edgeOnly` | Solo cantos | 0 | 1 | 0 | no | 1 | — |

El deshilachado (papel, tela, césped) queda para la v0.2: `grass 07` usa la familia que se le proponga.

### Familias de daño (objetivo)

Se combinan y se ponderan. El tipo de material propone una mezcla por defecto:

- Desconchado (pintura, esmalte, laca): bordes en escalón con levantamiento.
- Rotura frágil (cerámica, ladrillo, piedra, hormigón): fractura angulosa siguiendo piezas.
- Astillado (madera): roturas alargadas en la dirección de la veta.
- Abolladura y abrasión (metal, plástico): deformación suave, brillo pulido en los cantos y arañazos.
- Deshilachado y rasgado (papel, tela, césped): bordes fibrosos, pérdida de opacidad. Queda para la v0.2.
- Erosión (cemento, mortero, piedra blanda): pérdida granular redondeada.
- Desgaste de cantos sin pérdida (cualquier material): solo color, roughness y curvatura en las aristas.

### Más allá del borde

Son capas opcionales que se aplican después del daño: suciedad en cavidades, escorrentía vertical, manchas de humedad, polvo en superficies horizontales del relieve y variación de tono por pieza. La v0.1 trae la suciedad de cavidad y la escorrentía (ver "Pasada de color"). La escorrentía baja hacia abajo en el atlas: los rectángulos no tienen todavía una orientación "arriba" propia.

## Estilos de daño

El material ya trae su estética; el estilo solo decide cómo se dibuja el daño.

- **Realista**: todo lo anterior, con microdetalle y transiciones físicas.
- **Estilizado**: las mismas reglas de estructura con formas simplificadas. Roturas con pocas aristas y bien legibles, sin microdetalle ruidoso, contorno opcional (oscuro o claro) en la línea de rotura, normal suavizada y escalones de altura cuantizados. La paleta se toma del material.
- **Pixel art**: el daño se genera en la **rejilla de píxeles del material** (que se detecta automáticamente y se puede corregir). No hay antialiasing ni degradados, solo colores que ya existen en la paleta del material (cuantizada) y formas que se leen en pocos píxeles. El atlas de salida es un múltiplo entero de esa rejilla y la exportación recomienda filtrado point. Un estilo "PS1" se consigue con estilizado más resolución baja y filtrado point; no es un estilo aparte.

## Comprobaciones automáticas

Se ejecutan sobre una composición de evaluación a 2048 px, tras cada cambio y antes de exportar; el sangrado se calcula a la resolución de exportación (decisión 50). Se muestran en el panel de comprobaciones y se pueden marcar en el atlas:

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

### Lo que hace la v0.1

La v0.1 trae seis comprobaciones: cobertura, islas, normal, proporciones, sangrado y sustrato. El resto de la tabla queda para la v0.2. Las calcula `runChecks` (TS puro en `packages/core/src/checks`) sobre una **composición de evaluación a 2048 px** de ancho, la misma que el preview pero a esa resolución; el sangrado se calcula a la resolución de exportación. Así lo decidió el usuario (2026-11-13, decisión 50): cumple la regla 3 de CLAUDE.md porque el export compone con las mismas entradas y las reglas van en metros, así que el resultado no depende de la resolución:

- Si el preview ya está a 2048 px y al día (mismo documento, material, estructura, máscara y sustrato), se leen sus mapas (solo un preview a 2048 px conserva `matNormal`). Si no, se compone aparte y esos mapas se liberan nada más leerlos.
- Se lanza 600 ms después de cada recomposición y antes de exportar.
- Nunca corre dos veces a la vez: las peticiones van en cola, una petición en cola a la que adelanta otra más nueva se salta, y un resultado que llega cuando ya hay otra petición o recomposición posterior no se guarda.
- A 2048 px un atlas de 8 m mide 3.9 mm por píxel, así que el borde mínimo de 4 mm ocupa al menos un píxel. Todas las distancias se dan en metros y se pasan a píxeles con los px/m de la evaluación, de modo que el resultado no depende de la resolución.

Cada fila tiene un estado (correcto, aviso o error), un mensaje en español llano, los rectángulos afectados y, si procede, puntos del atlas. Al hacer clic en una fila con puntos, la vista se centra en el primero.

| Comprobación | Regla de la v0.1 |
|---|---|
| Cobertura de borde | Solo con `minEdgeM > 0`. Se recorre el perímetro visible de cada rectángulo (sin el fondo de ranura) y, en cada punto, la franja del borde mínimo hacia dentro, de ancho `min(minEdgeM, 0.5·wEff)`. Si un tramo de más de 2 cm no tiene `wearMask` en esa franja, da aviso, con el punto medio de cada tramo. Si el borde mínimo mide menos de un píxel de la evaluación (atlas muy anchos), no se comprueba y el mensaje lo dice; un trim fino con un borde de menos de un píxel se salta |
| Islas | Manchas de pérdida visible (`wearMask ≥ 128`) dentro de un rectángulo que no llegan a la franja de desgaste de borde: ningún píxel a menos de `wEff` del borde visible. Antes de etiquetarlas se puentean los huecos de hasta `bandM`, como si la máscara se dilatara `bandM/2`: dos píxeles perdidos del mismo rectángulo se unen si sus centros distan como mucho `bandM·px/m + 1` px (y siempre con vecindad 8). Sin límite de área. Si hay alguna, da aviso, con el centroide de cada una (R38). La regla de R38 con la franja del borde garantizado (`1.6·rimM` + 1 px) avisaba en todos los ladrillos por defecto (bricks wall 13: 337, 208, 323 y 173 islas con intensidad 0.5 y 1 y semillas 0 y 7): eran desconchones a 1–3 cm del canto, separados del borde por más de `bandM`. Por eso se usa la franja `wEff` del brief; las motas sueltas dentro de esa franja no se marcan (pendiente, decisión 51) |
| Coherencia de normal | La misma definición que el test de la Task 9 (R40, R41): Sobel sobre la altura macro, con y hacia arriba. La pendiente del material es la mayor entre la del relieve propio (Sobel de la altura final menos la macro) y la de su normal de detalle (`|n.xy| / n.z` de `matNormal`, la normal del material ya muestreada en el atlas; plana sin normal map). Como en `normalFromHeight.wgsl`, esa normal de detalle se desvanece hacia (0, 0, 1) según `wearMask` antes de medirla: lo perdido se lleva su relieve. Es así porque un normal map puede llevar mucho más relieve que su height. Solo cuentan los píxeles donde la pendiente macro pasa de 0.2 **y** supera a la del material; en ellos se exige `dot(n.xy, −grad macro) ≥ 0`. Donde el relieve del material es más fuerte (una junta de baldosa que cruza el bisel), la normal sigue al material con razón y no se juzga. Si falla más del 0.5 % de los píxeles contados, da error |
| Proporciones | `checkProportions` con el periodo girado de cada rectángulo. Si hay problemas, da aviso, con el centro de cada rectángulo |
| Sangrado | Si la ranura visible (fondo `groove.widthM` más el bisel a cada lado, `2·groove.bevelM`) mide menos de 4 px a la resolución de exportación, da aviso: la ranura desaparece en mip 2 y hay que ensanchar la ranura o el bisel. Con los valores por defecto (6 + 2·3 mm = 12 mm en 8 m) mide 6.1 px a 4096 y está bien (R35) |
| Sustrato | Solo con segundo set y un material con piezas. Compara el color medio del BaseColor del segundo set con el color medio de las juntas del propio material superior, en espacio de material: su BaseColor al tamaño del análisis de estructura donde `pieceId` es 0, sin la suciedad ni el desgaste del atlas (R37). Se calcula una vez por material y estructura. La diferencia es ΔE76 en Lab (sRGB → lineal → XYZ D65 → Lab). Si pasa de 20, da aviso |

Con el desgaste apagado (interruptor "Activar" o mapas de 1×1), con alcance 0 o con una familia que no quita material (`dent`, `edgeOnly`), la cobertura y las islas dan "correcto" y el mensaje lo explica. Con el desgaste apagado, el sustrato también da "correcto": no queda nada al descubierto.

### Interruptores de desgaste y suciedad

Las secciones Desgaste y Suciedad tienen un interruptor "Activar" en la cabecera (`enabled` en `WearParams` y `DirtParams`, encendido por defecto; los documentos sin el campo se abren encendidos). Apagado, la composición es la misma que sin ese nodo (decisión 69):

- **Desgaste apagado**: no hay pérdida ni altura de desgaste; `loss`, `border` y `wearMask` son marcadores de 1×1, `_WearMask` sale negro y `hotspot.json` no lleva el bloque `wear`. Es la salida de la v0.1-A.
- **Suciedad apagada**: ni suciedad de cavidad ni escorrentía, aunque los parámetros digan otra cosa; `allowMirrorY` y el `Can mirror` de Anvil vuelven a seguir al layout.

Los ajustes de la sección se conservan y se ven atenuados mientras está apagada. La escorrentía empieza en 0 por defecto, así que el espejo está libre mientras el usuario no pida chorretones.

Las islas y las demás comprobaciones nunca bloquean: solo la coherencia de normal puede dar error, y aun así se puede exportar. `runChecks` y el análisis de estructura corren en el hilo principal (unos 0.5–0.7 s y 1.3 s); pasarlos a un Worker queda pendiente (ver [10](10-roadmap.md)).

## Variedad

Seed global más seeds por rectángulo, desplazamiento del material por rectángulo, mezcla de familias, escalas y la máscara B/N. Dos proyectos con parámetros distintos deben dar atlas que no se parezcan: no puede haber patrones fijos, texturas de ruido incluidas que se repitan ni formas de rotura de una biblioteca pequeña. Todo el ruido es procedural y se evalúa en coordenadas del mundo con dominio deformado.
