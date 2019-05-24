const React = require('react')
const { comToPlugin, inIFrame } = require('dcs-client')

//------------------------------------------------------------------------------

let g_browserHistory = null
let g_discourseDidThis = false
const g_instancesWaitingForCounts = new Set()
let g_counts = null

// Return a modified component
exports.withCounts = (WrappedComponent, pathname = null) =>
  class WithCounts extends React.Component {
    constructor(props) {
      super(props)

      if (!pathname && !g_browserHistory) {
        throw new Error(
          'You need to call runReactRouterSync() before you can use withCounts()'
        )
      }

      this.pathname = pathname || g_browserHistory.location.pathname

      this.state = { counts: this._filteredCounts() }
    }

    updateCounts() {
      this.setState({ counts: this._filteredCounts() })
    }

    _filteredCounts() {
      return g_counts
        ? g_counts.filter(c => c.pathname === this.pathname)
        : null
    }

    componentDidMount() {
      if (!this.state.counts) {
        g_instancesWaitingForCounts.add(this)
      }
    }

    componentWillUnmount() {
      g_instancesWaitingForCounts.delete(this)
    }

    render() {
      //return <WrappedComponent {...this.props} counts={this.state.counts} />
      return React.createElement(WrappedComponent, {
        ...this.props,
        counts: this.state.counts
      })
    }
  }

//------------------------------------------------------------------------------

// This function is designed to run as much code as possible when there
// is no iframe. THIS IS FOR DEBUGGING PURPOSE, so that the package can be
// tested without an iframe. I know the code could have been simpler with
// a single "if (!inIFrame()) return" at the begining.
exports.runReactRouterSync = ({ browserHistory, routeMatcher }) => {
  g_browserHistory = browserHistory

  // Handle internal React route changes by analysing the url, extract Docuss
  // query params and set the Discourse route accordingly.
  // This is *not* called at load time, which is good, because Discourse is the 
  // leader and we want to react to its first onDiscourseRoutePushed instead.
  browserHistory.listen(async (location, method) => {
    if (g_discourseDidThis) {
      return
    }

    // Get query params
    const params = new URLSearchParams(location.search)
    const layoutStr = params.get('dcs-layout')
    const layout = layoutStr ? parseInt(layoutStr) : undefined
    const interactMode = params.get('dcs-interact-mode') || undefined
    const triggerId = params.get('dcs-trigger-id') || undefined
    const pathname = params.get('dcs-pathname') || undefined

    // Check query params
    if (!!interactMode !== (layout === 2 || layout === 3)) {
      throw new Error(
        'dcs-react-router-sync: invalid query param (dcs-layout or dcs-interact-mode'
      )
    }
    if (triggerId && !(layout === 2 || layout === 3)) {
      throw new Error(
        'dcs-react-router-sync: invalid query param (dcs-layout or dcs-trigger-id)'
      )
    }
    if (!!pathname !== (layout === 1)) {
      throw new Error(
        'dcs-react-router-sync: invalid query param (dcs-layout or dcs-pathname)'
      )
    }

    // No query params: quit
    if (layout === undefined) {
      return
    }

    // Get the existing page name or create a new one
    const pageName = await routeMatcher.getPageName(location.pathname)

    // Set the new route
    if (inIFrame()) {
      comToPlugin.postSetDiscourseRoute({
        route: { layout, pageName, interactMode, triggerId, pathname },
        mode: 'REPLACE',
        clientContext: { iDidThis: true }
      })
    }
  })

  if (!inIFrame()) {
    return
  }

  comToPlugin.onDiscourseRoutePushed(
    async ({ route, descr, counts, clientContext }) => {
      // Store the counts, enriches with the associated pathnames
      if (!g_counts) {
        const countPromises = counts.map(c =>
          routeMatcher
            .getPathname(c.pageName)
            .then(pathname => Object.assign({}, c, { pathname }))
        )
        g_counts = await Promise.all(countPromises)
        g_instancesWaitingForCounts.forEach(wc => wc.updateCounts())
      }

      if (clientContext && clientContext.iDidThis) {
        return
      }

      if (route.layout === 1) {
        return
      }

      const pathname = await routeMatcher.getPathname(route.pageName)
      if (!pathname) {
        throw new Error(`Cannot find pathname for page "${route.pageName}"`)
      }
      const params = route.triggerId ? `?dcs-trigger=${route.triggerId}` : ''
      const path = pathname + params

      // This test is necessary. Indeed, browserHistory.replace() actually
      // performs a replace even if the url hasn't change, which in turn
      // call the history.listen() hook.
      const loc = browserHistory.location
      const lastPath = loc.pathname + loc.search + loc.hash
      if (path !== lastPath) {
        // Don't store this in the history state, otherwise it will interfere
        // when user clicks the back button
        g_discourseDidThis = true

        browserHistory.replace(pathname)

        g_discourseDidThis = false
      }
    }
  )
}

//------------------------------------------------------------------------------
