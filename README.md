# Legalize ES

Consulta legislativa integrada de **8.642 leyes espanolas** (BOE) con **Derecho de la Union Europea** (EUR-Lex).

Interfaz web que permite buscar, leer, comparar reformas y explorar relaciones normativas de la legislacion espanola consolidada. Tambien funciona en **GitHub Pages** con un modo estatico demostrativo cuando no hay backend Node.js disponible.

---

## Funcionalidades

### Busqueda y filtrado
- Busqueda full-text en el contenido completo de las leyes
- Filtros por **tipo de norma** (Ley, Ley Organica, Real Decreto, Orden, etc.)
- Filtros por **estado** (vigente / derogado) y **rango de fechas**
- Resultados con snippets contextuales y resaltado de coincidencias

### Texto legal con formato
- Rendering Markdown avanzado con tipografia serif profesional
- Deteccion automatica de articulos, disposiciones y secciones
- **Tabla de contenidos** navegable generada automaticamente
- Resaltado de terminos de busqueda dentro del texto

### Historial de reformas
- Timeline visual con todas las versiones de cada ley (via `git log`)
- Identificacion de disposiciones modificadoras (BOE-ID)
- Listado de articulos afectados en cada reforma
- Cache en memoria: primera carga ~90ms, siguientes ~17ms

### Visor de diffs
- Comparacion linea a linea tipo GitHub para cada reforma
- Lineas anadidas (verde) y eliminadas (rojo) con conteo
- Navegacion directa desde el historial a cualquier diff
- Cache en memoria: primera carga ~700ms, siguientes ~7ms

### Mapa de relaciones normativas
- **Legislacion espanola** referenciada (navegable entre leyes)
- **Derecho UE**: Directivas, Reglamentos y Decisiones con:
  - Numero CELEX generado automaticamente
  - Consulta SPARQL a EUR-Lex para obtener titulo oficial y estado
  - Enlaces directos a EUR-Lex (HTML, PDF, ELI)
- **Convenios internacionales** detectados automaticamente
- **Referencias inversas**: normas que citan la ley actual
- Ordenacion por importancia (rango normativo) y ano
- Navegacion con **breadcrumbs** entre leyes relacionadas

---

## Arquitectura

```
legalize-ui/
  server.js          # Backend Node.js/Express (API REST)
  data/laws.json     # Datos estaticos generados para GitHub Pages
  public/
    index.html       # Frontend SPA (vanilla JS, CSS custom)
    data/laws.json   # Copia de datos estaticos para Express local
  package.json       # Dependencia unica: express
```

### Backend (`server.js`)

| Endpoint | Descripcion |
|----------|-------------|
| `GET /api/search?q=...&rango=...&estado=...&desde=...&hasta=...` | Busqueda full-text con filtros |
| `GET /api/law/:id` | Texto completo + metadatos YAML |
| `GET /api/law/:id/history` | Historial git de reformas |
| `GET /api/law/:id/diff/:hash` | Diff de un commit especifico |
| `GET /api/law/:id/relations` | Mapa de relaciones normativas |
| `GET /api/eurlex/:celex` | Consulta SPARQL a EUR-Lex |
| `POST /api/eurlex/batch` | Consulta batch de multiples CELEX |
| `GET /api/stats` | Estadisticas generales |

### Fuentes de datos

- **BOE**: Repositorio [legalize-es](https://github.com/legalize-dev/legalize-es) (8.642 leyes en Markdown con frontmatter YAML, historial git de reformas)
- **EUR-Lex**: API SPARQL publica (`publications.europa.eu/webapi/rdf/sparql`) + URLs directas ELI

---

## GitHub Pages

Este repositorio ya incluye una configuracion lista para publicar en GitHub Pages mediante GitHub Actions.

1. Sube los cambios a la rama `main`.
2. En GitHub, abre **Settings > Pages**.
3. En **Build and deployment**, selecciona **GitHub Actions**.
4. Ejecuta el workflow **Deploy to GitHub Pages** o espera al siguiente `push` a `main`.

La version publicada sirve `index.html` desde la raiz del repositorio. Como GitHub Pages no ejecuta `server.js`, el workflow clona `legalize-dev/legalize-es`, genera `data/laws.json` y el frontend detecta `github.io` para buscar y abrir leyes desde ese JSON estatico. El backend local sigue ofreciendo funciones dinamicas como historial Git completo, diffs reales y consultas EUR-Lex en vivo.

---

## Instalacion

### Requisitos
- Node.js >= 18
- Git
- Repositorio [legalize-es](https://github.com/legalize-dev/legalize-es) clonado localmente

### Pasos

```bash
# 1. Clonar el repositorio de leyes
git clone https://github.com/legalize-dev/legalize-es.git

# 2. Clonar este proyecto
git clone https://github.com/joduzu/legalize-ui.git
cd legalize-ui

# 3. Instalar dependencias
npm install

# 4. Configurar la ruta al repositorio de leyes
#    Editar LAWS_DIR y REPO_DIR en server.js

# 5. Iniciar el servidor
node server.js
```

La aplicacion estara disponible en **http://localhost:3737**

---

## Stack tecnologico

| Componente | Tecnologia |
|-----------|-----------|
| Backend | Node.js + Express 5 |
| Frontend | Vanilla JS, CSS custom (dark theme) |
| Tipografia | Inter (UI), Literata (texto legal), JetBrains Mono (diffs) |
| Datos BOE | Markdown + YAML frontmatter + Git history |
| Datos UE | EUR-Lex SPARQL + ELI URLs |
| Cache | In-memory (history, diffs, SPARQL) |

---

## Uso como herramienta de consulta

### Buscar legislacion sobre un tema
1. Escribe el termino en el buscador (ej: "biodiversidad", "proteccion de datos")
2. Filtra por tipo de norma o estado si necesitas precision
3. Haz clic en cualquier resultado para ver el texto completo

### Ver historial de reformas
1. Abre una ley y haz clic en la pestana **Reformas**
2. Cada entrada del timeline muestra fecha, disposicion modificadora y articulos afectados
3. Haz clic en **Ver cambios** para ver el diff exacto

### Explorar relaciones normativas
1. Abre una ley y haz clic en la pestana **Relaciones**
2. Las referencias se agrupan por tipo: BOE, UE, internacionales
3. Las normas UE muestran titulo oficial via SPARQL y enlaces a EUR-Lex
4. Haz clic en cualquier norma BOE para navegar a ella (con breadcrumbs para volver)

---

## Licencia

ISC

---

Desarrollado con [Claude Code](https://claude.ai/claude-code)
