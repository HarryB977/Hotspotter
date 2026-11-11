# 01 · Visión

## Qué es

Hotspotter es una herramienta local, con interfaz web servida en localhost, que convierte un material PBR tileable (o no PBR: basta un albedo) en un **atlas hotspot**: una sola textura con rectángulos de varios tamaños y proporciones, con bisel y desgaste en los bordes, más la definición de esos rectángulos. El resultado se usa en Blender, Maya, Unity (ProBuilder, Anvil CSG), Unreal o Source 2.

## Por qué

Las texturas hotspot casi no existen para descargar, y hacerlas a mano requiere ser artista. Los materiales PBR tileables, en cambio, abundan (packs de Unity, freestylized.com, etc.). Las herramientas para **aplicar** hotspots ya existen (plugins de Blender, la extensión de ProBuilder de HarryTools, Anvil CSG, Hammer). Lo que falta es poder **fabricar** el atlas.

Criterio de éxito del usuario: *si la herramienta saca una textura hotspot usable a partir de cualquier PBR tileable de una web como freestylized.com, el trabajo está hecho.*

## Usuarios

- El autor (desarrollador, no artista) y sus compañeros de equipo, que reciben la herramienta como release portable.
- Opcionalmente, artistas que quieran control fino (vista de nodos).

## Objetivos

1. Entrada: un set tileable con los mapas que tenga (albedo obligatorio; normal, height, roughness, metallic, AO, opacidad opcionales). Salida: atlas hotspot con los mismos mapas más la definición de rectángulos.
2. **Respetar las proporciones del material.** Ladrillos, tablones, azulejos o franjas de pintura a una altura fija se muestran a la misma escala del mundo en todos los rectángulos, empiezan en una junta y nunca se estiran.
3. **Desgaste de borde procedural y con sentido físico.** Nace de la estructura del material (piezas y juntas), se esculpe sobre un único campo de altura coherente y se valida con comprobaciones automáticas. Ver [04-wear.md](04-wear.md).
4. **Variedad.** Dos atlas hechos con la misma herramienta no deben parecerse si se cambian los parámetros oportunos. Debe cubrir cualquier material: césped, madera, cerámica, ladrillo, cristal, metal, plástico, papel, cemento, pintura…
5. **Versatilidad de estilo.** El material de entrada ya trae su estética; la herramienta la respeta. El estilo del daño se elige: realista, estilizado o pixel art.
6. **Calidad antes que velocidad.** Vista previa rápida mientras se ajusta, y un render final en GPU que puede tardar lo que haga falta.
7. **IA local opcional**, gestionada desde la propia app: genera materiales tileables desde cero y redibuja el desgaste de los bordes. Ver [07-ai.md](07-ai.md).
8. Interfaz de herramienta profesional: oscura, densa en información y usable. Ver [05-ui.md](05-ui.md).

## No objetivos

- Transferir estilo (convertir un material realista en cartoon o pixel art).
- Pintar a mano sobre el atlas con pinceles (v1).
- Aplicar hotspots a modelos del usuario. La vista 3D usa formas de prueba; el mapeado real lo hacen las herramientas de destino.
- Actualizar la app automáticamente reemplazando archivos (v1 solo avisa).
- Servicios en la nube o cuentas de usuario.

## Antiobjetivos (si pasa esto, ha fracasado aunque "funcione")

- Una pieza estirada o una hilada descuadrada entre rectángulos.
- Desgaste que parezca pegado encima: transiciones sin rotura alrededor, saltos de normal que contradicen el relieve, una capa inferior que no casa con el material.
- Bordes sin daño, motas sueltas flotando, detalle que se rompe al bajar de resolución.
- Tener que abrir otra ventana o programa (para la IA o para cualquier otra cosa) para completar el flujo.
- Una interfaz de "página web" espaciosa y de bajo contraste en lugar de una herramienta.
