# Hotspotter

Generador local de texturas **hotspot** (atlas de rectángulos con bisel y desgaste) a partir de materiales PBR tileables. UI web en localhost, distribuido como release portable `.exe` para Windows.

## Lo esencial

- Documentación por temas en [docs/](docs/README.md). Léela antes de cambiar comportamiento; actualízala al cambiarlo.
- Decisiones cerradas en [docs/09-decisions.md](docs/09-decisions.md). No las reabras sin preguntar al usuario. Añade allí las nuevas.
- Al fusionar algo que note quien usa la app, añade una línea en español en `## [Sin publicar]` de [CHANGELOG.md](CHANGELOG.md): son las notas del próximo release (`npm run release`, ver docs/08).
- Idioma: el usuario y el equipo hablan español. Docs y textos de la UI en español primero; el código y los comentarios, en inglés.
- La extensión de ProBuilder en `C:\Users\enriq\Desktop\Enrique\Git\HarryTools\Packages\com.harryb97.tools.probuilderextensions\` es **solo referencia**: no se modifica nunca.

## Reglas de producto que no se negocian

1. Las proporciones del material (hiladas, tablones, bandas) se respetan en todos los rectángulos: misma escala del mundo, arranque en junta, nada estirado.
2. El desgaste se esculpe sobre un único campo de altura; normal y AO se derivan de él. Nunca se mezclan normales a ciegas.
3. Las comprobaciones automáticas de `docs/04-wear.md` deben pasar en el render final o avisar.
4. La IA es opcional: la herramienta debe ser completa sin ella, y la IA nunca abre ventanas externas.
5. UI de herramienta profesional: oscura y densa (ver `docs/05-ui.md`).

## Stack (ver docs/02-architecture.md)

Monorepo npm workspaces · TypeScript · React + Vite + Tailwind + shadcn/ui · three.js · React Flow · motor WebGPU/WGSL · servidor Node 22 · sidecar Python (IA).

## Entorno del autor

Windows 10, RTX 3060, Node 22, Python 3.13, Git 2.40. Shell: PowerShell y Git Bash.

## Secretos

El repo es público y los releases salen sin token. Si algún día se usa uno (secreto `HOTSPOTTER_READ_TOKEN`, ver docs/08), se inyecta en el build y nunca se commitea. Los commits usan la dirección noreply de GitHub del autor, nunca su correo personal.
