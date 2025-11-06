tour.ia — paquete completo (deployable)
---------------------------------------
Contenido:
- server.js (backend Node/Express)
- public/ (frontend)
  - index.html (home: banner, trending, groups preview, sobre mi, faq)
  - grupos.html
  - planificador.html (chat + form)
  - historial.html
  - styles.css, theme.js, app.js, planificador.js, historial.js, grupos.js
- data/history.json (almacén de historial)
- package.json
- .env.example
- README.md

Instrucciones locales:
1. Descomprime el ZIP.
2. Copia .env.example -> .env y añade OPENAI_API_KEY.
3. npm install
4. npm start
5. Abre http://localhost:3000

Despliegue en Render:
- Subir repo a GitHub.
- Crear Web Service en Render apuntando al repo.
- Build command: npm install
- Start command: npm start
- Añadir variable OPENAI_API_KEY en panel de Render.

Notas:
- El banner y trending se cachean una vez al día para ahorrar tokens.
- El historial guarda respuestas completas y se indexa por hash SHA-256 de la IP para privacidad.
- Unsplash se usa en cliente para imágenes (source.unsplash.com).
