module.exports = wallaby => ({
  files: [`src/**/*.js`, `!src/**/*.test.js`],
  tests: [`src/**/*.test.js`],
  env: {
    kind: `chrome`
  }
})
