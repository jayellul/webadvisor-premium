// app.js

const puppeteer = require('puppeteer')
const wait = require('waait')

// Time between each check in ms
const msBetweenChecks = 60000
// Warning - recursion
checkWebadvisor()

async function checkWebadvisor() {
  // Headful
  // const browser = await puppeteer.launch({ headless: false })
  // Headless
  const browser = await puppeteer.launch()
  const page = await browser.newPage()

  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))

  await page.goto('https://webadvisor.uoguelph.ca')
  await page.waitForNavigation({ waitUntil: 'networkidle0' })

  await Promise.all([
    page.click('#sidebar > div > div.subnav > ul > li:nth-child(2) > a'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  await Promise.all([
    page.click('#sidebar > div > ul:nth-child(2) > li > a'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  // Fill out Search for Sections
  await Promise.all([
    page.select('#VAR1', 'F20'),
    page.select('#LIST_VAR1_1', 'CIS'),
    page.evaluate(() => {
      const courseCode = document.querySelector('#LIST_VAR3_1')
      courseCode.value = 3260
    }),
  ])

  await Promise.all([
    page.click('#content > div.screen.WESTS12A > form > div > input'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  // Determine if offering is open
  let open = false
  await page.evaluate(() => {
    const offerings = document.querySelectorAll('#GROUP_Grp_WSS_COURSE_SECTIONS > table > tbody > tr')
    offerings.forEach((row, index) => {
      // First two rows are just headings
      if (index < 2) return
      // Look for a course row that doesn't have the closed styles
      if (row.className !== 'closed') open = true
    })
  })

  const now = new Date()
  console.log(`\nTIME: ${now.getHours()}:${now.getMinutes()}`)
  if (open) {
    console.log('\x1b[32m', '\nDESIGN 4 IS OPEN')
  } else {
    console.log('\x1b[31m', '\nDESIGN 4 IS NOT OPEN')
  }

  console.log('\x1b[37m', '\nAYO, THREAD CHECK\n')
  await browser.close()
  // Wait and then check again
  await wait(msBetweenChecks)
  checkWebadvisor()
}
