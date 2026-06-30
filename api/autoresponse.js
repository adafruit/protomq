export default (router, broker) => {
  console.log("Installing Autoresponse Command")

  router.post('/autoresponse', (req, res) => {
    const { response } = req.body

    broker._customCheckinResponse = response

    console.log(`Autoresponse set:\n  ${JSON.stringify(response, null, 2)}`)

    res.json({ status: "OK" })
  })
}
