const React = require('react')
const ReactDOM = require('react-dom')
const { comToPlugin, inIFrame } = require('dcs-client')

//------------------------------------------------------------------------------

let g_routeMatcher = null
let g_discourseDidThis = false
let g_discoursePushedData = null
const g_components = new Set()
let g_prevSelectedNode = null
let g_selectedNode = null

//------------------------------------------------------------------------------

// This function is designed to run as much code as possible when there
// is no iframe. THIS IS FOR DEBUGGING PURPOSE, so that the package can be
// tested without an iframe. I know the code could have been simpler with
// a single "if (!inIFrame()) return" at the begining.
exports.runReactRouterSync = ({ browserHistory, routeMatcher }) => {
  if (g_routeMatcher) {
    throwError('"runReactRouterSync" should be called only once')
  }
  g_routeMatcher = routeMatcher

  //***** Handle internal React route changes *****
  // Parse the url, extract Docuss query params and set the Discourse route accordingly.
  // This is *not* called at load time, which is good, because Discourse is the
  // leader and we want to react to its first onDiscourseRoutePushed instead.
  browserHistory.listen(async (location, method) => {
    // Get query params
    const params = new URLSearchParams(location.search)
    const layoutStr = params.get('dcs-layout')
    const layout = layoutStr ? parseInt(layoutStr) : 0
    const interactMode = params.get('dcs-interact-mode') || undefined
    const triggerId = params.get('dcs-trigger-id') || undefined

    // Check query params
    if (!!interactMode !== (layout === 2 || layout === 3)) {
      throwError('invalid query param (dcs-layout or dcs-interact-mode)')
    }
    if (triggerId && !(layout === 2 || layout === 3)) {
      throwError('invalid query param (dcs-layout or dcs-trigger-id)')
    }
    if (layout && (layout < 0 || layout === 1 || layout > 3)) {
      throwError('unsupported query param (dcs-layout)')
    }

    // Update the "selected" state in registered components
    g_components.forEach(c => c._updateSelected(triggerId))

    if (g_discourseDidThis) {
      return
    }

    g_discoursePushedData = null

    // Get the existing page name or create a new one
    const pageName = await routeMatcher.getPageName(location.pathname)

    // Set the new route
    if (inIFrame()) {
      comToPlugin.postSetDiscourseRoute({
        route: { layout, pageName, interactMode, triggerId },
        mode: 'REPLACE',
        clientContext: { iDidThis: true }
      })
    }
  })

  if (!inIFrame()) {
    return
  }

  //***** Handle Discourse route changes *****
  // When a route change is triggerd by Disourse, we need to change the React
  // Router route
  comToPlugin.onDiscourseRoutePushed(
    async ({ route, descr, counts, clientContext }) => {
      // Store the pushed data and update registered components (see withDcs below)
      g_discoursePushedData = { currentRoute: route, counts }
      g_components.forEach(c => c._updateCount())

      if (clientContext && clientContext.iDidThis) {
        return
      }

      if (route.layout === 1) {
        return
      }

      // Get the pathname corresponding to the new route
      const pathname = await routeMatcher.getPathname(route.pageName)
      if (!pathname) {
        throwError(`Cannot find pathname for page "${route.pageName}"`)
      }

      // Add the correct query params. It is not necessary for this module,
      // but required for users to know the current route.
      let params = ''
      if (route.layout !== 0) {
        params = `?dcs-layout=${route.layout}&dcs-interact-mode=${
          route.interactMode
        }`
        if (route.triggerId) {
          params += `&dcs-trigger-id=${route.triggerId}`
        }
      }
      // This test is necessary. Indeed, browserHistory.replace() actually
      // performs a replace even if the url hasn't change, which in turn
      // call the history.listen() hook.
      if (location.pathname !== pathname || location.search !== params) {
        // Don't store this in the history state, otherwise it will interfere
        // when user clicks the back button
        g_discourseDidThis = true

        browserHistory.replace(pathname + params)

        g_discourseDidThis = false
      }
    }
  )

  // Resize event with debounce
  // https://developer.mozilla.org/en-US/docs/Web/Events/resize#setTimeout
  window.addEventListener('resize', evt => {
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      const node = g_selectedNode || g_prevSelectedNode
      if (node) {
        node.scrollIntoView({ behavior: 'smooth' })
      }
    }, 100)
  })
}

//------------------------------------------------------------------------------

// Return a modified WrappedComponent with additional dcsCount and dcsSelected properties
// - pathname is optional. If not provided, the pageName corresponding to the current page is used.
// - The triggerId, if there is one, must be passed as a prop
exports.withDcs = (WrappedComponent, pathname = undefined) =>
  class WithDcs extends React.Component {
    constructor(props) {
      super(props)

      if (!g_routeMatcher) {
        throwError('please call "runReactRouterSync" before using "withDcs"')
      }

      this.pageNameFromPathname =
        pathname && g_routeMatcher.getPageName(pathname)

      const dcsSelected =
        new URLSearchParams(location.search).get('dcs-trigger-id') ===
        this.props.triggerId

      this.state = { dcsCount: undefined, dcsSelected }

      g_components.add(this)

      if (g_discoursePushedData) {
        this._updateCount(true)
      }
    }

    componentWillUnmount() {
      g_components.delete(this)
    }

    componentDidMount() {
      if (this.state.dcsSelected) {
        // Scroll the component into view
        g_selectedNode = ReactDOM.findDOMNode(this)
        g_selectedNode.scrollIntoView()
      }
    }

    async _updateCount(init = false) {
      if (this.state.dcsCount !== undefined) {
        return
      }

      const { counts, currentRoute } = g_discoursePushedData

      const triggerId = this.props.triggerId

      const pageName = this.pageNameFromPathname
        ? await this.pageNameFromPathname
        : currentRoute.pageName

      if (!pageName) {
        return
      }

      const found = counts.find(
        c =>
          c.pageName === pageName &&
          (triggerId === undefined || c.triggerId === triggerId)
      )
      const dcsCount = found ? found.count : 0

      // If we awaited for this.pageNameFromPathname, we are not in the
      // constructor anymore!
      if (init && !this.pageNameFromPathname) {
        this.state.dcsCount = dcsCount
      } else {
        this.setState({ dcsCount })
      }
    }

    _updateSelected(selectedTriggerId) {
      const dcsSelected =
        this.props.triggerId && this.props.triggerId === selectedTriggerId
      if (this.state.dcsSelected !== dcsSelected) {
        this.setState({ dcsSelected })
        if (dcsSelected) {
          g_prevSelectedNode = g_selectedNode
          g_selectedNode = ReactDOM.findDOMNode(this)
        } else if (!selectedTriggerId) {
          g_prevSelectedNode = g_selectedNode
          g_selectedNode = null
        }
      }
    }

    render() {
      return React.createElement(WrappedComponent, {
        ...this.props,
        dcsCount: this.state.dcsCount,
        dcsSelected: this.state.dcsSelected
      })
    }
  }

//------------------------------------------------------------------------------

function throwError(msg) {
  throw new Error('dcs-react-router-sync: ' + msg)
}

//------------------------------------------------------------------------------
