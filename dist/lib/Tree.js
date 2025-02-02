/* eslint-disable no-labels,max-depth,complexity */
import React, { createRef, PureComponent } from 'react';
import mergeRefs from 'react-merge-refs';
import { noop } from './utils';
// eslint-disable-next-line @typescript-eslint/naming-convention,@typescript-eslint/prefer-readonly-parameter-types
export const Row = ({
  index,
  data: {
    component: Node,
    getRecordData,
    treeData
  },
  style,
  isScrolling
}) => {
  const data = getRecordData(index);
  return /*#__PURE__*/React.createElement(Node, Object.assign({
    isScrolling: isScrolling,
    style: style,
    treeData: treeData
  }, data));
};

// If refresh is required, we will run the TreeWalker. It will completely
// update all requests and reset every state to default.
const generateNewTree = ({
  createRecord
}, {
  buildingTaskTimeout,
  placeholder,
  async = false,
  treeWalker
}, state) => {
  const shouldPreservePreviousState = // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  async && state.records !== undefined;
  const {
    records: previousRecords
  } = state;
  const order = [];
  const records = new Map();
  const requestIdleCallbackOptions = buildingTaskTimeout ? {
    timeout: buildingTaskTimeout
  } : undefined;
  const meta = new WeakMap();
  const iter = treeWalker();
  const {
    value: root
  } = iter.next(); // Each record has a link to a parent, the next sibling and the next child.
  // Having this info, we can perform a depth-first traverse.

  const rootRecord = createRecord(root.data, state, undefined, shouldPreservePreviousState ? previousRecords.get(root.data.id) : undefined);
  records.set(rootRecord.public.data.id, rootRecord);
  meta.set(rootRecord, root);
  let currentRecord = rootRecord;
  let isTraversingRoot = true;
  let tempRecord = rootRecord;
  const useIdleCallback = 'requestIdleCallback' in window && placeholder !== undefined && // If placeholder is set to null and this is the first build, idle callback
  // won't be used. It is necessary for trees with async data which can be
  // extremely complex but the first build is quite easy. During the following
  // idle callbacks the old tree will be shown.
  !(placeholder === null && !state.order);
  const hasTime = useIdleCallback ? deadline => deadline.timeRemaining() > 0 : () => true;

  const task = deadline => {
    while (currentRecord !== null) {
      if (!hasTime(deadline)) {
        requestIdleCallback(task, requestIdleCallbackOptions);
        return;
      }

      if (!currentRecord.visited) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const {
          value: child
        } = iter.next(meta.get(currentRecord)); // When the generator returns the undefined value we consider that all
        // children are already sent and we need to select the new parent
        // element to get its children.

        if (child === undefined) {
          if (isTraversingRoot) {
            isTraversingRoot = false;
          } else {
            if (currentRecord.isShown) {
              order.push(currentRecord.public.data.id);
            }

            currentRecord.visited = currentRecord.child !== null;
            currentRecord = currentRecord.child !== null ? currentRecord.child : currentRecord.sibling !== null ? currentRecord.sibling : currentRecord.parent;
          }

          tempRecord = currentRecord;
          continue;
        }

        const childRecord = createRecord(child.data, state, isTraversingRoot ? undefined : currentRecord, shouldPreservePreviousState ? previousRecords.get(child.data.id) : undefined);
        records.set(childRecord.public.data.id, childRecord);
        meta.set(childRecord, child);

        if (!isTraversingRoot && tempRecord === currentRecord) {
          tempRecord.child = childRecord;
        } else {
          tempRecord.sibling = childRecord;
        }

        tempRecord = childRecord;
      } else {
        currentRecord.visited = false;
        currentRecord = currentRecord.sibling !== null ? currentRecord.sibling : currentRecord.parent;
        tempRecord = currentRecord;
      }
    }

    if (useIdleCallback) {
      state.setState({
        order,
        records,
        updateRequest: {}
      });
    }
  };

  if (useIdleCallback) {
    requestIdleCallback(task, requestIdleCallbackOptions);
  } else {
    task();
  } // If we want to preserve the previous state and use the requestIdleCallback,
  // we need to return the old state.


  return placeholder !== undefined && async && state.order ? state : {
    order,
    records
  };
};

const MAX_FUNCTION_ARGUMENTS = 32768; // If we need to perform only the update, treeWalker won't be used. Update will
// work internally, traversing only the subtree of elements that require
// update through the opennessState option.

const updateExistingTree = ({
  order,
  records
}, {
  opennessState
}) => {
  if (typeof opennessState !== 'object') {
    return null;
  }

  for (const id in opennessState) {
    if (!records.has(id)) {
      continue;
    }

    const opts = opennessState[id];
    const ownerRecord = records.get(id); // Here we unify the shape of openness state options

    const {
      open,
      subtreeCallback = noop
    } = typeof opts === 'boolean' ? {
      open: opts
    } : opts;
    let update = noop;
    let apply = noop;

    if (ownerRecord.isShown) {
      if (open) {
        // If received rules require us to open the subtree, we have 2 cases:
        // 1. The node is not opened yet. In this case we simply have to
        // calculate and add new ids.
        // 2. The node is opened already. In this case we have to remove all
        // existing ids and replace them with new ids.
        const index = order.indexOf(id); // Here we calculate a count of visible subtree nodes to remove from
        // `order`. Then we will replace the gap with the updated list of
        // subtree nodes.

        let recordNextToSubtree = ownerRecord;

        while (recordNextToSubtree !== null) {
          if (recordNextToSubtree.sibling !== null) {
            recordNextToSubtree = recordNextToSubtree.sibling;
            break;
          }

          recordNextToSubtree = recordNextToSubtree.parent;
        }

        const countToRemove = recordNextToSubtree === null ? order.length - 1 - index : order.indexOf(recordNextToSubtree.public.data.id) - 1 - index;
        const orderParts = [[index + 1, countToRemove]];
        let orderPartsCursor = 0; // Unfortunately, splice cannot work with big arrays. If array exceeds
        // some length it may fire an exception. The length is specific for
        // each engine; e.g., MDN says about 65536 for Webkit. So, to avoid this
        // overflow, I split `order` parts to chunks by 32768 elements in each
        // one. These chunks will be sent as arguments to the `splice` method.
        //
        // To avoid array concatenations which may cause Major GC, I set two
        // first arguments as `splice`'s `start` and `deleteCount` arguments.

        update = record => {
          // We have to consider only the newly shown elements that are not in
          // the order list yet. We should do it AFTER the visibility update
          // happens because otherwise we won't be able to distinguish if the
          // element should be included in the order list.
          // Update record visibility
          record.isShown = record.parent ? record.parent.public.isOpen && record.parent.isShown : true;

          if (record.isShown) {
            orderParts[orderPartsCursor].push(record.public.data.id);

            if (orderParts[orderPartsCursor].length === MAX_FUNCTION_ARGUMENTS) {
              orderPartsCursor += 1;
              orderParts.push([index + 1 + orderPartsCursor * MAX_FUNCTION_ARGUMENTS, 0]);
            }
          }
        };

        apply = () => {
          for (let i = 0; i < orderParts.length; i++) {
            // @ts-expect-error: too generic for TS
            order.splice(...orderParts[i]);
          }
        };
      } else if (ownerRecord.public.isOpen) {
        // If received rules require us to close the subtree, we have to remove
        // all subtree ids from the order list.
        const index = order.indexOf(id);
        let count = 0;

        update = record => {
          // We have to consider only currently visible subtree nodes BEFORE
          // their visibility is updated. Otherwise we will have incorrect
          // number of items to remove: we cannot remove elements that are not
          // in the order list.
          //
          // If we do it after the visibility update, we will be unable to
          // understand if the element is still in the order list.
          if (record.isShown) {
            count += 1;
          } // Update record visibility


          record.isShown = record.parent ? record.parent.public.isOpen && record.parent.isShown : true;
        };

        apply = () => {
          // Remove data after element with index
          order.splice(index + 1, count);
        };
      }
    }

    let currentRecord = ownerRecord;

    while (currentRecord !== null) {
      if (!currentRecord.visited) {
        currentRecord.public.isOpen = currentRecord === ownerRecord ? open : currentRecord.public.isOpen;
        subtreeCallback(currentRecord.public, ownerRecord.public);

        if (currentRecord !== ownerRecord) {
          update(currentRecord);
        }

        currentRecord.visited = currentRecord.child !== null; // This algorithm is a bit different from the visit algorithm in the
        // tree generator. We are restricted with the bounds of a subtree and
        // shouldn't go over it. So we cannot search for the ownerRecord's
        // parent or sibling because it will lead us out of the subtree.

        currentRecord = // Look for child in any case
        currentRecord.child !== null ? currentRecord.child : // Stop looking for next element if currentRecord is root.
        currentRecord === ownerRecord ? null : // Otherwise, look for sibling or parent
        currentRecord.sibling !== null ? currentRecord.sibling : currentRecord.parent;
      } else {
        currentRecord.visited = false;
        currentRecord = currentRecord === ownerRecord ? null : currentRecord.sibling !== null ? currentRecord.sibling : currentRecord.parent;
      }
    }

    apply();
  }

  return {
    order,
    records,
    updateRequest: {}
  };
};

export const createTreeComputer = creatorOptions => (props, state, options) => options.refresh ? generateNewTree(creatorOptions, props, state) : updateExistingTree(state, options);

class Tree extends PureComponent {
  static getDerivedStateFromProps(props, state) {
    const {
      listRef = null,
      treeWalker
    } = props;
    const {
      computeTree,
      list,
      order,
      treeWalker: oldTreeWalker
    } = state;
    return {
      attachRefs: mergeRefs([list, listRef]),
      ...(treeWalker !== oldTreeWalker || !order ? computeTree(props, state, {
        refresh: true
      }) : null),
      treeWalker
    };
  }

  constructor(props, context) {
    super(props, context);
    this.getRecordData = this.getRecordData.bind(this);
    /* eslint-disable react/no-unused-state,@typescript-eslint/consistent-type-assertions */

    this.state = {
      list: /*#__PURE__*/createRef(),
      recomputeTree: this.recomputeTree.bind(this),
      setState: this.setState.bind(this)
    };
    /* eslint-enable react/no-unused-state,@typescript-eslint/consistent-type-assertions */
  }

  getItemData() {
    const {
      children: component,
      itemData: treeData
    } = this.props;
    return {
      component,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getRecordData: this.getRecordData,
      treeData
    };
  }

  getRecordData(index) {
    const {
      order,
      records
    } = this.state;
    return records.get(order[index]).public;
  }

  recomputeTree(state) {
    return new Promise(resolve => {
      this.setState(prevState => prevState.computeTree(this.props, prevState, {
        opennessState: state
      }), resolve);
    });
  }

  scrollTo(scrollOffset) {
    var _this$state$list$curr;

    // eslint-disable-next-line react/destructuring-assignment
    (_this$state$list$curr = this.state.list.current) == null ? void 0 : _this$state$list$curr.scrollTo(scrollOffset);
  }

  scrollToItem(id, align) {
    var _this$state$list$curr2;

    // eslint-disable-next-line react/destructuring-assignment
    (_this$state$list$curr2 = this.state.list.current) == null ? void 0 : _this$state$list$curr2.scrollToItem(this.state.order.indexOf(id), align);
  }

}

Tree.defaultProps = {
  rowComponent: Row
};
export default Tree;