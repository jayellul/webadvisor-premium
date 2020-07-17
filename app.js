// app.js

const { exec } = require('child_process')
const puppeteer = require('puppeteer')
const wait = require('waait')

// Time between each check in ms
const msBetweenChecks = 120000
// Webadvisor course variables
const courseSemester = 'F20'
const courseSubject = 'CIS'
const courseCode = 3260
// Start daemon
start()

async function start() {
  while (true) {
    try {
      await checkWebadvisor()
    } catch (error) {
      console.log(error)
    }
  }
}

async function checkWebadvisor() {
  // Headful
  const browser = await puppeteer.launch()
  // Headless
  // const browser = await puppeteer.launch()
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
    page.select('#VAR1', courseSemester),
    page.select('#LIST_VAR1_1', courseSubject),
    page.evaluate(function (courseCode) {
      const courseCodeInput = document.querySelector('#LIST_VAR3_1')
      courseCodeInput.value = courseCode
    }, courseCode),
  ])

  await Promise.all([
    page.click('#content > div.screen.WESTS12A > form > div > input'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  // Determine if offering is open - evaluated in browser
  const open = await page.evaluate(() => {
    let open = false
    const offerings = document.querySelectorAll('#GROUP_Grp_WSS_COURSE_SECTIONS > table > tbody > tr')
    offerings.forEach((row, index) => {
      // First two rows are just headings
      if (index < 2) return
      // Look for a course row that doesn't have the closed styles
      if (!row.className && row.className !== 'closed') open = true
    })
    return open
  })

  const now = new Date()
  console.log(`\nTIME: ${now.getHours()}:${now.getMinutes()}`)
  const output = `${courseSemester}, ${courseSubject} * ${courseCode}`
  if (open) {
    exec(`say "${output} is open"`)
    console.log('\x1b[32m', `\n${output} IS OPEN`)
  } else {
    console.log('\x1b[31m', `\n${output} IS NOT OPEN`)
  }

  console.log('\x1b[37m', '\nAYO, THREAD CHECK\n')
  await browser.close()
  // Wait and then check again
  await wait(msBetweenChecks)
}
