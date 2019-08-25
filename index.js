const React = require('react')
const ReactDOM = require('react-dom')
const { comToPlugin, inIFrame } = require('dcs-client')

//------------------------------------------------------------------------------

let g_routeMatcher = null
let g_discourseDidThis = false
let g_discoursePushedData = null
const g_components = new Set()

//------------------------------------------------------------------------------

exports.runReactRouterSync = ({ browserHistory, routeMatcher }) => {
  if (g_routeMatcher) {
    throwError('"runReactRouterSync" should be called only once')
  }
  g_routeMatcher = routeMatcher

  // This function is designed to run as much code as possible when there
  // is no iframe. THIS IS FOR DEBUGGING PURPOSE, so that the package can be
  // tested without an iframe. I know the code could have been simpler with
  // a single "if (!inIFrame()) return" at the beginning.

  //***** Handle internal React route changes *****
  // Parse the url, extract Docuss query params and set the Discourse route
  // accordingly.
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
      throwError('invalid query param dcs-layout or dcs-interact-mode')
    }
    if (triggerId && !(layout === 2 || layout === 3)) {
      throwError('invalid query param dcs-layout or dcs-trigger-id')
    }
    if (layout < 0 || layout > 3) {
      throwError('invalid query param dcs-layout')
    }

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
  // When a route change is triggered by Discourse, we need to change the React
  // Router route
  comToPlugin.onDiscourseRoutePushed(
    async ({ route, descr, counts, clientContext }) => {
      g_discoursePushedData = { route, counts }

      if (!clientContext || !clientContext.iDidThis) {
        // Get the pathname corresponding to the new route
        const pathname =
          route.layout === 1
            ? route.pathname
            : await routeMatcher.getPathname(route.pageName)
        if (!pathname) {
          const error = `Cannot find pathname for page "${route.pageName}"`
          comToPlugin.postSetRouteProps({ error })
          throwError(error)
        }

        // Add the correct query params. It is not necessary, but nice to have
        // for debug purpose
        let params = `?dcs-layout=${route.layout}`
        if (route.interactMode) {
          params += `&dcs-interact-mode=${route.interactMode}`
        }
        if (route.triggerId) {
          params += `&dcs-trigger-id=${route.triggerId}`
        }

        // This test is necessary. Indeed, browserHistory.replace() actually
        // performs a replace even if the url hasn't change, which in turn
        // call the history.listen() hook.
        if (location.pathname !== pathname || location.search !== params) {
          // Don't store g_discourseDidThis in the history state, otherwise it
          // will interfere when user clicks the back button
          g_discourseDidThis = true
          browserHistory.replace(pathname + params)
          g_discourseDidThis = false
        }
      }

      // Update all WithDcs components with the new route
      g_components.forEach(c => c._updateState())
    }
  )
}

//------------------------------------------------------------------------------

// Return a modified WrappedComponent with additional dcsCount and dcsSelected
// properties
// - pathname is optional. If not provided, the pageName corresponding to the
// current page is used.
// - The triggerId, if any, must be passed as a prop
exports.withDcs = (WrappedComponent, pathname = undefined) =>
  class WithDcs extends React.Component {
    constructor(props) {
      super(props)

      // Check init
      if (!g_routeMatcher) {
        throwError('please call "runReactRouterSync" before using "withDcs"')
      }

      // Get the pageName
      this.pageNameFromPathname =
        pathname && g_routeMatcher.getPageName(pathname)

      // Init the component state
      this.state = { dcsCount: undefined, dcsSelected: false }
    }

    componentDidMount() {
      // Store the component in a global list
      g_components.add(this)

      // Update the state if a route has already been received
      if (g_discoursePushedData) {
        this._updateState()
      }
    }

    componentWillUnmount() {
      // Remove the component from the global list
      g_components.delete(this)
    }

    shouldComponentUpdate(nextProps, nextState) {
      return (
        nextState.dcsSelected !== this.state.dcsSelected ||
        nextState.dcsCount !== this.state.dcsCount
      )
    }

    async _updateState() {
      const { route, counts } = g_discoursePushedData

      // See if the component is selected
      const dcsSelected =
        !!route.triggerId && route.triggerId === this.props.triggerId

      // Get the count (only the first time)
      let dcsCount = this.state.dcsCount
      if (dcsCount === undefined) {
        const pageName = this.pageNameFromPathname
          ? await this.pageNameFromPathname
          : route.pageName
        if (pageName) {
          const found = counts.find(
            c =>
              c.pageName === pageName &&
              (this.props.triggerId === undefined ||
                c.triggerId === this.props.triggerId)
          )
          dcsCount = found ? found.count : 0
        }
      }

      // Update the component state
      const previouslySelected = this.state.dcsSelected
      this.setState({ dcsCount, dcsSelected }, () => {
        // Scroll to the selected trigger, even if it was already selected
        // (because layout change requires scrolling again).
        // Also, if no trigger is selected anymore, scroll to the previously
        // selected one.
        if (dcsSelected || (previouslySelected && !route.triggerId)) {
          // Wait for the split bar animation to end, then scroll to the selected node
          setTimeout(() => {
            const node = ReactDOM.findDOMNode(this)
            // The dcsScrollIntoView property allows to override the default 
            // scroll behavior
            const scrollFn = this.props.dcsScrollIntoView || defaultScrollIntoView
            scrollFn(node, route)
          }, 500)
        }
      })
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

function defaultScrollIntoView(node, route) {
  const rect = node.getBoundingClientRect()
  const partiallyVisible = rect.top < window.innerHeight && rect.bottom >= 0
  if (!partiallyVisible) {
    node.scrollIntoView({ behavior: 'smooth' })
  }
}

//------------------------------------------------------------------------------

function throwError(msg) {
  throw new Error('dcs-react-router-sync: ' + msg)
}

//------------------------------------------------------------------------------
