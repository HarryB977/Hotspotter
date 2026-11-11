# 06 · Exportación

## Mapas

Se exporta un PNG por mapa (8 o 16 bits; height también en EXR de 32 bits) con un prefijo común: `<nombre>_BaseColor`, `_Normal`, `_Height`, `_Roughness`, `_Metallic`, `_AO`, `_Opacity` (si existe), más dos auxiliares: `_RectID` (color por rectángulo) y `_WearMask` (daño 0–1, útil para shaders).

### Presets por destino

| Preset | Normal | Empaquetado |
|---|---|---|
| Blender / Maya | OpenGL | mapas sueltos |
| Unity URP | OpenGL | `_MetallicSmoothness` (R metal, A smoothness) + AO aparte |
| Unity HDRP | OpenGL | `_MaskMap` (R metal, G AO, B detail mask, A smoothness) |
| Unreal | DirectX | `_ORM` (R AO, G rough, B metal) |
| Source 2 | DirectX | mapas sueltos según convención de Source 2 |
| Pixel / Retro | (opcional) | mapas sueltos a la resolución de la rejilla, con aviso de usar filtrado point |
| Personalizado | elegible | empaquetado de canales libre, guardable como preset propio |

## Definición de rectángulos

Siempre se exporta `<nombre>.hotspot.json`, el formato propio y la fuente de verdad: versión, tamaño del atlas en px, ancho en metros, densidad y la lista de rectángulos con todos los campos de [03](03-material-and-layout.md) en píxeles (origen arriba a la izquierda) y en UV (0–1, origen abajo a la izquierda).

Formatos adicionales opcionales:

- **Valve `.rect`** (Source 2 / Hammer): rectángulos en píxeles con su flag de rotación. El constructor debe verificar la sintaxis exacta con un archivo `.rect` real o con la documentación de Source 2, porque la página de la wiki que se revisó no la detalla.
- **Anvil CSG**: Anvil no tiene un formato importable; su layout se crea en el editor ("Detect Grid" a partir de las ranuras, o a mano). Por eso: (a) las ranuras por defecto están pensadas para que "Detect Grid" las encuentre, y (b) se exporta una tabla legible (`.anvil.txt`/CSV) con X, Y, Width, Height en px desde arriba a la izquierda, Can rotate, Can mirror, Repeats across/down, Use on y Sheet Width (m), para meterla a mano o con un script futuro.
- **HarryTools ProBuilder Extensions**: un `.json` que un pequeño importador del lado de Unity pueda convertir en `HotspotLayout` (World Width, patches con Allow Rotation, Allow Mirror X/Y, Allow Tiling, Inset). El importador de Unity queda fuera de este repo; no se toca la herramienta existente.
- **Blender**: el JSON propio. Un addon de Blender queda fuera del alcance de v1.

## Carpeta de salida

La elige el usuario y se recuerda por proyecto. Al volver a exportar se sobrescriben los mismos nombres de archivo, para que los motores mantengan las referencias. También se puede exportar todo en un `.zip`.
