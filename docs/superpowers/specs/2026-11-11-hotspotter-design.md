# Hotspotter · Documento de diseño (2026-11-11)

El diseño está repartido por temas en `docs/`. Este archivo es el punto de entrada y fija qué versión se aprobó.

## Resumen

Herramienta local (UI web en localhost, release portable `.exe` para Windows) que convierte cualquier material PBR tileable en un atlas hotspot con desgaste de borde procedural y coherente con el material, respetando sus proporciones, y exporta mapas y la definición de rectángulos para Blender, Maya, Unity (ProBuilder, Anvil CSG), Unreal y Source 2. Incluye una IA de imagen local opcional, gestionada desde la app, para generar materiales tileables y redibujar bordes.

## Lectura en orden

1. [Visión](../../01-vision.md): intención, objetivos, no objetivos, antiobjetivos
2. [Arquitectura](../../02-architecture.md)
3. [Material, estructura y layout](../../03-material-and-layout.md)
4. [Desgaste de borde](../../04-wear.md)
5. [Interfaz](../../05-ui.md)
6. [Exportación](../../06-export.md)
7. [IA local](../../07-ai.md)
8. [Distribución y actualizaciones](../../08-distribution.md)
9. [Registro de decisiones](../../09-decisions.md)
10. [Versiones](../../10-roadmap.md)
11. [Banco de pruebas](../../11-test-bench.md)

## Referencias revisadas

- Extensión de ProBuilder de HarryTools (`C:\Users\enriq\Desktop\Enrique\Git\HarryTools\Packages\com.harryb97.tools.probuilderextensions\`): solo referencia, no se modifica.
- Anvil CSG, Hotspot Texturing: https://2yeet.gitbook.io/anvilcsg/surfaces-and-content/hotspot-texturing
- Valve, Source 2 Hotspot Texturing: https://developer.valvesoftware.com/wiki/Source_2_Docs/Level_Design/Hotspot_Texturing

## Lo que queda al constructor

- Elegir las librerías concretas dentro de las decisiones de stack, el empaquetador del `.exe` y los modelos de IA (con un spike en una RTX 3060).
- Medidas exactas de los layouts preset.
- Algoritmos concretos de segmentación, empaquetado automático y daño, siempre que cumplan los principios y las comprobaciones de `04-wear.md`.
- Orden de implementación dentro de cada versión (lo fija el plan).
