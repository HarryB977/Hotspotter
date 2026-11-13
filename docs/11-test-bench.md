# 11 · Banco de pruebas

La carpeta `samples/` (aportada por el usuario) es la referencia con la que se juzga la calidad.

> `samples/` está en `.gitignore`: son materiales de terceros y el repo podría hacerse público algún día. Los tests que dependen de ellos se saltan si la carpeta no existe.

## `samples/pbr/`: materiales de entrada

Sets de 1K con basecolor, normal GL y DX, height, roughness, AO y, en algunos, metallic. Varios son **estilizados** (por ejemplo, `bricks wall 13`: ladrillo gris pintado a mano con grietas dibujadas).

| Set | Tipo según [03](03-material-and-layout.md) | Qué pone a prueba |
|---|---|---|
| bricks wall 13 | con piezas | hiladas enteras, rotura por pieza, estilo estilizado |
| floor tiles 06 | con piezas | rejilla 2D, arranque en junta en los dos ejes |
| wood planks 12 | con piezas (direccional) | tablones enteros a lo ancho, astillado según la veta |
| wooden wall 03 | con piezas (direccional) | ídem en pared |
| concrete wall 01 | continuo | daño sin piezas, erosión, escorrentía |
| metal 01 | continuo | abolladura, abrasión, brillo en los cantos |
| grass 07 | fibroso | bordes deshilachados y opacidad; caso límite |

## `samples/examples/`: resultados objetivo

- **metal.png**: paneles metálicos con óxido en las ranuras, desconchones puntuales y halo de color alrededor del daño. Es el nivel de detalle de borde al que se apunta.
- **concrete.jpg**: layout en guillotina con ranuras finas y hundidas, y escorrentía vertical desde los bordes superiores. El daño de borde es sutil.
- **brick wall.jpg**: el sustrato aparece **en zonas grandes**, no solo en el borde (ladrillo bajo un enlucido gastado), y hay ranuras largas que cruzan el atlas.
- **various.jpg**: explorador de materiales de Hammer (Source 2). Muestra que un mismo layout se reutiliza con **muchas variantes** (`concrete_painted_white_hs05a/b/c`, `_blue`, `_beige`…), con **bandas pintadas** a una altura fija, franjas de otro material (grava, vegetación) y algún decal (números). Confirma que hacen falta las variantes sobre el mismo layout y las bandas.

## Lo que esto añade al diseño

1. **Revelado en zona**, además del revelado en borde: la capa superior se pierde en manchas grandes guiadas por ruido, la máscara B/N o la curvatura. Por ejemplo, enlucido sobre ladrillo. Va en el mismo campo de altura y con las mismas reglas de fractura que el daño de borde.
2. **Variantes**: un proyecto puede tener varias variantes (tinte, bandas, seed de daño, sustrato) que comparten el layout. Se exportan todas de una vez con sufijo (`_a`, `_b`, `_blue`…).
3. Las **ranuras** del layout son finas, hundidas y oscuras por defecto (como en concrete.jpg y metal.png), lo que además ayuda a la detección de Anvil.

## `npm run bench`

`scripts/bench.mjs` lanza `apps/web/e2e/bench.spec.ts` (etiqueta `@bench`, fuera del `npm run e2e` normal) con un solo worker y abre el índice al terminar. Si no puede abrir un navegador (por ejemplo, en CI), solo escribe la ruta.

Para cada carpeta de `samples/pbr/`, en el mismo orden que la app:

1. Importa la carpeta con el selector de carpeta.
2. Deja que el análisis proponga la estructura y la familia de desgaste.
3. Pone el layout automático `mixed` con semilla 1.
4. Hace lo mismo que el botón Exportar: resolución 2048, comprobaciones a esa resolución y export Unity URP con `composeInputFor`.

La salida va a `samples/_bench/<AAAAMMDD-HHmm>/<set>/`: los PNG, `.hotspot.json`, la tabla Anvil, miniaturas de 256 px en `thumbs/` y `bench.json` con el resumen. `index.html` muestra, por set, las miniaturas de BaseColor, Normal, Height y WearMask (cada una enlaza al mapa completo) y la tabla de comprobaciones. Es un archivo local, con rutas relativas y sin recursos externos.

El banco pasa si todos los sets exportan sin errores y ninguna comprobación sale en `error`. Los avisos se listan pero no lo hacen fallar. Si falta `samples/pbr`, `npm run bench` lo dice y termina con código 0 sin lanzar Playwright.

## Criterio de aceptación por versión

Cada versión se da por buena cuando cada set de `samples/pbr/` aplicable a esa versión produce un atlas que el usuario, comparando con `samples/examples/`, considera usable, y las comprobaciones automáticas pasan. Se guardan capturas de referencia (golden) de cada set para detectar regresiones.
